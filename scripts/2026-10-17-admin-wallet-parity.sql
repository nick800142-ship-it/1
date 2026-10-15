-- 後台用戶詳細紀錄與用戶錢包共用同一份交易組裝邏輯，需要讓管理員讀到與用戶相同的來源資料。

-- 管理員可讀所有鏈上結算紀錄（用戶錢包的「待處理/失敗」狀態依此判斷）。
drop policy if exists onchain_settlements_select_admin on public.onchain_settlements;
create policy onchain_settlements_select_admin
  on public.onchain_settlements
  for select
  to authenticated
  using (private.is_admin());

-- 與 get_my_rwmt_town_transactions 完全相同的欄位，指定用戶、限管理員。
create or replace function public.admin_get_user_wallet_town_transactions(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', 'town-' || o.id::text,
      'kind', case when o.result = 'bomb' then 'bomb' else 'ae' end,
      'house', o.house_index,
      'amount', case when o.result = 'bomb' then abs(o.jc_penalty) else 1 end,
      'net', case when o.result = 'bomb' then -abs(o.jc_penalty) else 1 end,
      'tx_hash', o.ae_tx_hash,
      'status', case when o.result = 'ae' then case when o.prize_status = 'paid' then 'confirmed' else 'pending' end else 'confirmed' end,
      'created_at', o.created_at,
      'paid_at', o.ae_paid_at
    ) order by o.created_at desc), '[]'::jsonb)
    from public.rwmt_town_opens o
    where o.user_id = p_user_id and (o.result = 'bomb' or o.result = 'ae')
  );
end;
$$;

revoke all on function public.admin_get_user_wallet_town_transactions(uuid) from public, anon;
grant execute on function public.admin_get_user_wallet_town_transactions(uuid) to authenticated;
