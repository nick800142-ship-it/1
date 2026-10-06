create or replace function public.reserve_vault_jc_purchase(jc_amount numeric, request_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare px numeric; usdt numeric; wallet text; prior public.settlement_reservations;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode = '42501'; end if;
  if request_key is null or length(trim(request_key)) < 8 then raise exception 'invalid request key'; end if;
  if jc_amount is null or jc_amount <= 0 or jc_amount > 100000000 then raise exception 'invalid amount'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  select * into prior from public.settlement_reservations where settlement_reservations.request_key = reserve_vault_jc_purchase.request_key for update;
  if found then
    if prior.action <> 'vault_buy' or prior.user_id <> auth.uid() or prior.jc_amount <> jc_amount then raise exception 'request key already used'; end if;
    return jsonb_build_object('request_key', prior.request_key, 'status', prior.status, 'jc', prior.jc_amount, 'usdt', prior.usdt_amount, 'tx_hash', prior.source_tx_hash, 'idempotent', true);
  end if;
  select wallet_address into wallet from public.profiles where id = auth.uid();
  if wallet is null or length(trim(wallet)) = 0 then raise exception 'no wallet bound'; end if;
  select jc_price into px from public.platform_config limit 1;
  if px is null or px <= 0 then raise exception 'jc price unavailable'; end if;
  usdt := round(jc_amount * px, 6);
  if usdt <= 0 then raise exception 'invalid amount'; end if;
  insert into public.settlement_reservations(request_key, action, user_id, jc_amount, usdt_amount, wallet_address, chain_payload)
    values(request_key, 'vault_buy', auth.uid(), jc_amount, usdt, wallet, jsonb_build_object('jc_price', px));
  return jsonb_build_object('request_key', request_key, 'status', 'pending', 'jc', jc_amount, 'usdt', usdt, 'jc_price', px);
end;
$function$;

create or replace function public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare prior public.settlement_reservations;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode = '42501'; end if;
  if request_key is null or length(trim(request_key)) < 8 then raise exception 'invalid request key'; end if;
  if jc_amount is null or jc_amount <= 0 or jc_amount > 100000000 then raise exception 'invalid amount'; end if;
  if tx_hash is null or tx_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid tx hash'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  select * into prior from public.settlement_reservations where settlement_reservations.request_key = vault_buy_jc_onchain.request_key for update;
  if not found then
    perform public.reserve_vault_jc_purchase(jc_amount, request_key);
    select * into prior from public.settlement_reservations where settlement_reservations.request_key = vault_buy_jc_onchain.request_key for update;
  end if;
  if prior.action <> 'vault_buy' or prior.user_id <> auth.uid() or prior.jc_amount <> jc_amount then raise exception 'request key already used'; end if;
  if prior.status <> 'pending' then return jsonb_build_object('direction', 'buy', 'status', prior.status, 'request_key', prior.request_key, 'jc', prior.jc_amount, 'usdt', prior.usdt_amount, 'tx_hash', prior.source_tx_hash, 'idempotent', true); end if;
  if prior.source_tx_hash is not null then
    if lower(prior.source_tx_hash) <> lower(tx_hash) then raise exception 'request key already used'; end if;
    return jsonb_build_object('direction', 'buy', 'status', 'pending', 'request_key', prior.request_key, 'jc', prior.jc_amount, 'usdt', prior.usdt_amount, 'tx_hash', prior.source_tx_hash, 'idempotent', true);
  end if;
  if exists(select 1 from public.asset_ledger where metadata ->> 'tx_hash' = tx_hash)
     or exists(select 1 from public.settlement_reservations where source_tx_hash = tx_hash) then raise exception 'tx hash already used'; end if;
  update public.settlement_reservations set source_tx_hash = lower(tx_hash), updated_at = now() where settlement_reservations.request_key = vault_buy_jc_onchain.request_key;
  return jsonb_build_object('direction', 'buy', 'status', 'pending', 'request_key', request_key, 'jc', prior.jc_amount, 'usdt', prior.usdt_amount, 'tx_hash', lower(tx_hash));
end;
$function$;

create or replace function public.release_unsubmitted_vault_jc_purchase(request_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare r public.settlement_reservations;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into r from public.settlement_reservations where settlement_reservations.request_key = release_unsubmitted_vault_jc_purchase.request_key for update;
  if not found or r.user_id <> auth.uid() or r.action <> 'vault_buy' then raise exception 'vault purchase reservation not found'; end if;
  if r.status = 'released' then return jsonb_build_object('status', 'released', 'idempotent', true); end if;
  if r.status <> 'pending' or r.source_tx_hash is not null then raise exception 'vault purchase already submitted'; end if;
  update public.settlement_reservations set status = 'released', updated_at = now() where settlement_reservations.request_key = release_unsubmitted_vault_jc_purchase.request_key;
  return jsonb_build_object('status', 'released');
end;
$function$;

revoke all on function public.reserve_vault_jc_purchase(numeric, text) from public, anon;
revoke all on function public.vault_buy_jc_onchain(numeric, text, text) from public, anon;
revoke all on function public.release_unsubmitted_vault_jc_purchase(text) from public, anon;
revoke all on function public.get_my_jc_balance() from public, anon;
grant execute on function public.reserve_vault_jc_purchase(numeric, text) to authenticated;
grant execute on function public.vault_buy_jc_onchain(numeric, text, text) to authenticated;
grant execute on function public.release_unsubmitted_vault_jc_purchase(text) to authenticated;
grant execute on function public.get_my_jc_balance() to authenticated, service_role;
