create or replace function public.admin_apply_asset_payout(p_ref_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  settlement public.onchain_settlements%rowtype;
  payout_type text;
  payout_amount numeric;
begin
  select * into settlement
  from public.onchain_settlements
  where ref_key = p_ref_key
  for update;

  if not found or settlement.action <> 'admin_payout' then
    raise exception '找不到管理員資產派發紀錄';
  end if;
  if settlement.status <> 'confirmed' then
    raise exception '鏈上交易尚未確認，不能更新網站錢包帳本';
  end if;
  if coalesce(settlement.payload ->> 'accounted', 'false') = 'true' then
    return true;
  end if;

  payout_type := settlement.payload ->> 'assetType';
  payout_amount := (settlement.payload ->> 'amount')::numeric;
  if payout_amount <= 0 then
    raise exception '派發數量必須大於 0';
  end if;

  if payout_type = 'jc' then
    insert into public.jc_ledger (
      user_id, entry_type, amount, idempotency_key, metadata
    ) values (
      settlement.user_id,
      'admin_payout',
      payout_amount,
      'admin-payout:' || settlement.ref_key,
      jsonb_build_object(
        'source', 'admin_hot_wallet',
        'tx_hash', settlement.tx_hash,
        'wallet', settlement.payload ->> 'wallet',
        'admin_payout_ref', settlement.ref_key
      )
    )
    on conflict (idempotency_key) do nothing;
  elsif payout_type in ('ae', 'rwa') then
    if settlement.asset_id is null then
      raise exception 'AE/RWA 派發缺少網站標的帳本 ID';
    end if;
    insert into public.holdings (user_id, asset_id, quantity, updated_at)
    values (settlement.user_id, settlement.asset_id, payout_amount, now())
    on conflict (user_id, asset_id) do update
      set quantity = public.holdings.quantity + excluded.quantity,
          updated_at = now();
  elsif payout_type <> 'usdt' then
    raise exception '不支援的資產派發類型';
  end if;

  update public.onchain_settlements
  set payload = payload || jsonb_build_object('accounted', true),
      updated_at = now()
  where id = settlement.id;

  return true;
end;
$function$;

revoke all on function public.admin_apply_asset_payout(text) from public, anon, authenticated;
grant execute on function public.admin_apply_asset_payout(text) to service_role;
