-- Pre-launch operations: DB-backed maintenance switch, hardened redemption rejection, reconciliation report.

alter table public.platform_config
  add column if not exists maintenance_mode boolean not null default false,
  add column if not exists maintenance_reason text,
  add column if not exists maintenance_updated_at timestamptz;

-- Admin toggle for the emergency stop. Every change is written to admin_audit_logs.
create or replace function public.admin_set_maintenance_mode(p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_reason is null or length(v_reason) < 2 then raise exception 'reason required'; end if;

  update public.platform_config
  set maintenance_mode = p_enabled,
      maintenance_reason = case when p_enabled then v_reason else null end,
      maintenance_updated_at = now(),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true;

  select email into v_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(v_email, ''), case when p_enabled then 'maintenance.enable' else 'maintenance.disable' end,
          'platform_config', 'maintenance_mode', jsonb_build_object('reason', v_reason, 'enabled', p_enabled));

  return jsonb_build_object('maintenance_mode', p_enabled, 'reason', v_reason);
end;
$$;
revoke all on function public.admin_set_maintenance_mode(boolean, text) from public, anon;
grant execute on function public.admin_set_maintenance_mode(boolean, text) to authenticated;

-- Rejection now requires a reason, releases the reservation and records the admin in the audit log.
-- Refund is idempotent: the refund ledger row has a unique idempotency key and the order must still be pending.
create or replace function public.admin_reject_redemption(order_id uuid, note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.redemption_orders;
  u_email text;
  v_note text := nullif(btrim(coalesce(note, '')), '');
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_note is null or length(v_note) < 2 then raise exception 'reason required'; end if;

  select * into o from public.redemption_orders where id = order_id for update;
  if not found then raise exception 'order not found'; end if;
  if o.status <> 'pending' then raise exception 'order already resolved'; end if;

  insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata)
  values (o.user_id, 'redemption_refund', o.jc_amount, o.idempotency_key || ':refund',
          jsonb_build_object('order_id', o.id, 'reason', 'rejected', 'note', v_note))
  on conflict (idempotency_key) do nothing;

  update public.redemption_orders
  set status = 'rejected', admin_id = auth.uid(), admin_note = v_note, resolved_at = now(), updated_at = now()
  where id = order_id;

  update public.settlement_reservations
  set status = 'released', updated_at = now()
  where request_key = o.idempotency_key and action = 'redeem' and status = 'pending';

  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, ''), 'redemption.reject', 'redemption_orders', order_id::text,
          jsonb_build_object('jc_amount', o.jc_amount, 'user_id', o.user_id, 'note', v_note));

  return jsonb_build_object('order_id', o.id, 'status', 'rejected');
end;
$$;

-- Read-only reconciliation across purchases, secondary trades, redemptions, commissions and on-chain settlements.
create or replace function public.admin_reconciliation_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues jsonb := '[]'::jsonb;
  v_ids text[];
  v_count int;
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  -- 1. completed redemption without a payout transaction hash
  select count(*), coalesce(array_agg(id::text) filter (where true), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'completed' and (tx_hash is null or length(tx_hash) < 10) limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_completed_no_tx','severity','critical','title','已完成贖回但缺少 USDT 撥款 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 2. rejected redemption without refund ledger row
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o
        where o.status = 'rejected'
          and not exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund')
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_rejected_no_refund','severity','critical','title','已拒絕贖回但沒有退回 JC','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 3. completed redemption that also has a refund (double payout risk)
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o
        where o.status = 'completed'
          and exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund')
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_paid_and_refunded','severity','critical','title','贖回同時撥款又退款（重複給付風險）','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 4. stale pending redemption (> 60 minutes)
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'pending' and created_at < now() - interval '60 minutes' limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_pending_stale','severity','warning','title','贖回待審核超過 60 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 5. confirmed on-chain settlement without tx hash
  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select ref_key from public.onchain_settlements where status = 'confirmed' and (tx_hash is null or length(tx_hash) < 10) and action not in ('wire_contracts') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_confirmed_no_tx','severity','critical','title','鏈上結算標示成功但缺少 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 6. failed or long-pending settlements
  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select ref_key from public.onchain_settlements
        where status = 'failed' or (status = 'pending' and updated_at < now() - interval '10 minutes') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_stuck','severity','warning','title','鏈上結算失敗或卡住超過 10 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 7. private purchases (older than 15 min) without any on-chain settlement row
  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'private_purchase' and l.created_at < now() - interval '15 minutes'
          and not exists (select 1 from public.onchain_settlements s where s.ref_key = 'subscribe:' || l.idempotency_key)
          and not exists (select 1 from public.jc_ledger r where r.entry_type = 'refund' and (r.metadata ->> 'source_key') = l.idempotency_key)
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','purchase_no_settlement','severity','warning','title','認購已扣款但沒有鏈上結算紀錄','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 8. vault JC purchases without mint settlement
  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'vault_buy' and l.created_at < now() - interval '15 minutes'
          and not exists (select 1 from public.onchain_settlements s
                          where s.ref_key = 'mint_jc:' || regexp_replace(l.idempotency_key, ':jc$', '') and s.status = 'confirmed')
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','vault_buy_no_settlement','severity','critical','title','金庫買幣已記帳但沒有成功的鏈上發幣','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 9. users with a negative spendable JC balance
  select count(*), coalesce(array_agg(user_id::text), '{}') into v_count, v_ids
  from (select user_id from public.jc_ledger where entry_type <> 'commission_pending'
        group by user_id having sum(amount) < -0.000001 limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','negative_jc_balance','severity','critical','title','用戶 JC 可用餘額為負數','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 10. commissions paid vs ledger
  select count(*) into v_count from public.admin_commission_discrepancies();
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','commission_mismatch','severity','warning','title','分潤應發與帳本實發不一致（可在派發頁沖正）','count',v_count,'samples','[]'::jsonb); end if;

  return jsonb_build_object('generated_at', now(), 'ok', jsonb_array_length(v_issues) = 0, 'issues', v_issues);
end;
$$;
revoke all on function public.admin_reconciliation_report() from public, anon;
grant execute on function public.admin_reconciliation_report() to authenticated;

-- Server-side maintenance flag reader for the relayer (service role only).
create or replace function public.get_maintenance_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('enabled', coalesce(maintenance_mode, false), 'reason', maintenance_reason)
  from public.platform_config where id = true;
$$;
grant execute on function public.get_maintenance_state() to anon, authenticated, service_role;
