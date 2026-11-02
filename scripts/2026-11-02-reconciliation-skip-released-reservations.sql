-- 對帳檢查（admin_reconciliation_report）第 6 項「鏈上結算失敗或卡住超過 10 分鐘」
-- 原本把所有 status='failed' 的 onchain_settlements 都列為警示。
-- 但「買方始終未付款 JC、鏈上從未送出任何交易」的認購預留，逾時後會由
-- releaseUnpaidSubscribeReservations 自動釋放（settlement_reservations.status='released'），
-- 對應的結算列被標成 failed 只是為了留下稽核紀錄，不需要、也不可能補發。
-- 這類終態不應持續佔住對帳警示，否則每一筆未付款的放棄認購都會變成永遠消不掉的警告。
-- 本遷移在第 6 項排除「預留已釋放」的結算列；其餘檢查項目維持與線上版本一致。

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
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'completed' and (tx_hash is null or length(tx_hash) < 10) limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_completed_no_tx','severity','critical','title','已完成贖回但缺少 USDT 撥款 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 2. rejected redemption without refund ledger row
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o where o.status = 'rejected'
        and not exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_rejected_no_refund','severity','critical','title','已拒絕贖回但沒有退回 JC','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 3. completed redemption that also has a refund (double payout risk)
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o where o.status = 'completed'
        and exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_paid_and_refunded','severity','critical','title','贖回同時撥款又退款（重複給付風險）','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 4. stale pending redemption (> 60 minutes)
  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'pending' and created_at < now() - interval '60 minutes' limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_pending_stale','severity','warning','title','贖回待審核超過 60 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 5. confirmed on-chain settlement without tx hash
  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select ref_key from public.onchain_settlements where status = 'confirmed' and (tx_hash is null or length(tx_hash) < 10) and action not in ('wire_contracts') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_confirmed_no_tx','severity','critical','title','鏈上結算標示成功但缺少 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 6. failed or long-pending settlements, excluding reservations that were released
  --    (buyer never paid and nothing was sent on-chain; the failed row is an audit trail, not a stuck job)
  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select s.ref_key from public.onchain_settlements s
        where (s.status = 'failed' or (s.status = 'pending' and s.updated_at < now() - interval '10 minutes'))
          and not exists (
            select 1 from public.settlement_reservations r
            where r.status = 'released'
              and s.ref_key in ('subscribe:' || r.request_key, 'mint_jc:' || r.request_key)
          )
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_stuck','severity','warning','title','鏈上結算失敗或卡住超過 10 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 7. private purchases (older than 15 min) without any on-chain settlement row
  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'private_purchase' and l.created_at >= timestamptz '2026-10-08 00:00:00+00' and l.created_at < now() - interval '15 minutes'
          and not exists (select 1 from public.onchain_settlements s where s.ref_key = 'subscribe:' || l.idempotency_key)
          and not exists (select 1 from public.jc_ledger r where r.entry_type = 'refund' and (r.metadata ->> 'source_key') = l.idempotency_key)
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','purchase_no_settlement','severity','warning','title','認購已扣款但沒有鏈上結算紀錄','count',v_count,'samples',to_jsonb(v_ids)); end if;

  -- 8. vault JC purchases without a confirmed mint settlement
  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'vault_buy' and l.created_at >= timestamptz '2026-10-08 00:00:00+00' and l.created_at < now() - interval '15 minutes'
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
