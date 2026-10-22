-- 主網：AE 歸零只取消掛單並停用 AE 輪次，不退款、不清空用戶持倉。
-- 不可設 is_delisted：list_visible_private_placements 會排除已下架標的，前台錢包就找不到 AE 而隱藏持倉。
-- 主網 AE 合約沒有收回功能，用戶錢包裡的 AE 一直是他們的，站內帳本必須和鏈上一致。
create or replace function public.admin_reset_ae_token() returns jsonb
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  admin_email text;
  ae_ids text[];
  cancelled_orders integer;
  delisted_placements integer;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  select array_agg(id) into ae_ids from public.private_placements where is_ae_token = true;
  if ae_ids is null then
    raise exception 'no ae token found';
  end if;

  with cancelled as (
    update public.p2p_orders
    set status = 'cancelled', updated_at = now()
    where asset_id = any(ae_ids) and status in ('open', 'partially_filled')
    returning 1
  )
  select count(*) into cancelled_orders from cancelled;

  with delisted as (
    update public.private_placements
    set is_active = false, available = 0, updated_at = now()
    where id = any(ae_ids)
    returning 1
  )
  select count(*) into delisted_placements from delisted;

  select email into admin_email from auth.users where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), admin_email, 'reset', 'ae_token', 'ae-token-daily',
    jsonb_build_object('cancelled_orders', cancelled_orders, 'wiped_holdings', 0,
      'delisted_placements', delisted_placements, 'refunded_jc', 0));

  return jsonb_build_object('cancelled_orders', cancelled_orders, 'wiped_holdings', 0,
    'delisted_placements', delisted_placements, 'refunded_jc', 0);
end;
$$;

-- 還原 2026-10-22 歸零誤清的資料：持倉以鏈上餘額為準，並沖銷當時退回的本金。
insert into public.holdings(user_id, asset_id, quantity, updated_at)
values
  ('603d58ca-1b8b-4560-b432-497bfbe9e932', 'ae-token-daily', 21, now()),
  ('a7187b5a-bd91-4d1e-8a50-dc4a30559b82', 'ae-token-daily', 16, now())
on conflict (user_id, asset_id) do update set quantity = excluded.quantity, updated_at = now();

insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
select user_id, 'refund', -amount, asset_id, 'ae-reset-refund-reversal:' || user_id, jsonb_build_object('reason', 'ae_reset_reversal')
from public.jc_ledger
where idempotency_key in (
  'ae-reset-refund:ae-token-daily:603d58ca-1b8b-4560-b432-497bfbe9e932',
  'ae-reset-refund:ae-token-daily:a7187b5a-bd91-4d1e-8a50-dc4a30559b82')
on conflict do nothing;
