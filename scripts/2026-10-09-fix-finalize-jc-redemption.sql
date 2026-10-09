-- Fix the redemption finalization function's invalid self-qualified parameter reference.
-- The previous function used finalize_jc_redemption.request_key while search_path was empty,
-- which PostgreSQL interpreted as a table reference and rejected with 42P01.
create or replace function public.finalize_jc_redemption(p_order_id uuid, p_jc_collect_tx text, p_usdt_tx text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.redemption_orders;
  r public.settlement_reservations;
  ledger_row public.jc_ledger;
  v_request_key text;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_jc_collect_tx !~ '^0x[0-9a-fA-F]{64}$' or p_usdt_tx !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'invalid chain transaction data';
  end if;

  select * into o from public.redemption_orders where id = p_order_id for update;
  if not found then raise exception 'redemption order not found'; end if;

  v_request_key := o.idempotency_key;
  select * into r
  from public.settlement_reservations sr
  where sr.request_key = v_request_key
  for update;
  if not found or r.action <> 'redeem' or r.user_id <> o.user_id then
    raise exception 'redemption reservation not found';
  end if;

  if o.status = 'completed' and r.status = 'confirmed' then
    return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'tx_hash', o.tx_hash, 'order_id', o.id);
  end if;
  if o.status <> 'pending' or r.status <> 'pending' then
    raise exception 'redemption is not pending';
  end if;

  perform 1 from public.profiles where id = o.user_id for update;
  perform set_config('app.settlement_request_key', v_request_key, true);
  insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata)
  values (
    o.user_id,
    'redemption_pending',
    -o.jc_amount,
    v_request_key || ':jc',
    jsonb_build_object('usdt', o.usdt_amount, 'jc_price', o.jc_price, 'jc_redeem_price', o.jc_price, 'jc_collect_tx', p_jc_collect_tx, 'usdt_tx', p_usdt_tx)
  )
  on conflict (idempotency_key) do nothing;

  select * into ledger_row from public.jc_ledger where idempotency_key = v_request_key || ':jc';
  if ledger_row.id is null then raise exception 'redemption ledger finalization failed'; end if;

  update public.redemption_orders
  set status = 'completed', jc_ledger_id = ledger_row.id, tx_hash = p_usdt_tx,
      admin_note = '系統自動撥款（鏈上即時結算）', resolved_at = now(), updated_at = now()
  where id = o.id;

  update public.settlement_reservations
  set status = 'confirmed', settled_at = now(), updated_at = now(),
      chain_payload = chain_payload || jsonb_build_object('jc_collect_tx', p_jc_collect_tx, 'usdt_tx', p_usdt_tx)
  where settlement_reservations.request_key = v_request_key;

  return jsonb_build_object('status', 'confirmed', 'tx_hash', p_usdt_tx, 'jc_collect_tx', p_jc_collect_tx, 'jc_amount', o.jc_amount, 'usdt_amount', o.usdt_amount, 'order_id', o.id);
end;
$$;

comment on function public.finalize_jc_redemption(uuid, text, text)
is 'Finalizes a JC redemption only after confirmed JC collection and USDT payout transactions.';

revoke all on function public.finalize_jc_redemption(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finalize_jc_redemption(uuid, text, text) to service_role;
