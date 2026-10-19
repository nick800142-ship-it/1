-- 2026-10-19 AE 獎勵回合「時間到自動結束」
-- 問題：獎勵回合到了 ends_at 之後沒有任何機制結束它，平常日（ae-token-daily）不會恢復，
--       剩餘份額也因 execute_private_purchase 的 ends_at 檢查而買不到，前台顯示「已結束」。
-- 修正：時間到視同管理員「提前結束獎勵機制」——凍結釋出（release_frozen_at = ends_at，
--       剩餘份額可依獎勵價買到清空為止）並恢復平常日。在載入標的清單與每次認購前自動執行。

create or replace function private.expire_ae_bonus_rounds()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  expired integer;
begin
  update public.private_placements
     set release_frozen_at = ends_at, updated_at = now()
   where is_ae_token = true
     and ae_token_kind = 'bonus'
     and is_active = true
     and release_frozen_at is null
     and ends_at <= clock_timestamp();
  get diagnostics expired = row_count;

  if expired > 0 then
    update public.private_placements
       set is_active = true, updated_at = now()
     where id = 'ae-token-daily'
       and is_active = false
       and not exists (
         select 1 from public.private_placements b
          where b.is_ae_token = true and b.ae_token_kind = 'bonus' and b.is_active = true
            and b.release_frozen_at is null and b.available > 0
       );
  end if;

  return expired;
end;
$function$;

revoke all on function private.expire_ae_bonus_rounds() from public, anon, authenticated;

create or replace function public.list_visible_private_placements()
returns setof public.private_placements
language plpgsql
volatile
security definer
set search_path to ''
as $function$
begin
  perform private.expire_ae_bonus_rounds();
  return query
    select p.*
      from public.private_placements as p
     where p.is_delisted = false
       and p.updated_at >= timestamptz '2026-10-04 11:57:00+08'
     order by p.created_at;
end;
$function$;

CREATE OR REPLACE FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.private_placements;
  prior public.settlement_reservations;
  gross numeric;
  px numeric;
  jc_bal numeric;
  reserved_quantity numeric;
  elapsed_intervals numeric;
  released numeric;
  purchased_so_far numeric;
  purchasable_now numeric;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode = '42501'; end if;
  if request_key is null or length(trim(request_key)) < 8 then raise exception 'invalid request key'; end if;
  if trade_quantity is null or trade_quantity <= 0 or trade_quantity > 1000000 or trade_quantity <> trunc(trade_quantity) then raise exception 'invalid quantity'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  select * into prior from public.settlement_reservations where settlement_reservations.request_key = execute_private_purchase.request_key for update;
  if found then
    if prior.user_id <> auth.uid() or prior.action <> 'subscribe' or prior.asset_id <> asset_key or prior.quantity <> trade_quantity then raise exception 'request key already used'; end if;
    return jsonb_build_object('request_key', prior.request_key, 'status', prior.status, 'gross', prior.jc_amount, 'total', prior.jc_amount, 'quantity', prior.quantity, 'entered_secondary_market', false);
  end if;
  perform private.expire_ae_bonus_rounds();
  select * into a from public.private_placements where id = asset_key for update;
  -- 已結束的 AE 獎勵回合（release_frozen_at 有值）剩餘份額可依獎勵價買到清空為止，不受 ends_at 限制。
  if not found or a.is_delisted or not a.is_active or (a.market_started_at is not null and not a.is_ae_token) or (clock_timestamp() >= a.ends_at and a.release_frozen_at is null) then raise exception 'asset unavailable'; end if;
  select coalesce(sum(r.quantity), 0) into reserved_quantity from public.settlement_reservations r where r.action = 'subscribe' and r.asset_id = asset_key and r.status = 'pending';
  if a.available - reserved_quantity < trade_quantity then raise exception 'asset unavailable'; end if;
  if a.is_ae_token then
    if a.release_interval_seconds is null or a.release_interval_seconds <= 0 or a.release_amount_per_interval is null or a.release_amount_per_interval <= 0 or a.release_started_at is null then raise exception 'ae token misconfigured'; end if;
    if a.release_frozen_at is not null then purchasable_now := a.available - reserved_quantity;
    else
      elapsed_intervals := floor(extract(epoch from (clock_timestamp() - a.release_started_at)) / a.release_interval_seconds);
      if elapsed_intervals < 0 then elapsed_intervals := 0; end if;
      released := least(a.total_supply, elapsed_intervals * a.release_amount_per_interval);
      purchased_so_far := a.total_supply - a.available;
      purchasable_now := released - purchased_so_far - reserved_quantity;
    end if;
    if trade_quantity > purchasable_now then raise exception 'ae token release limit exceeded: only % unit(s) released so far', greatest(purchasable_now, 0); end if;
  end if;
  if a.price is null or a.price <= 0 then raise exception 'invalid price'; end if;
  gross := round(trade_quantity * a.price, 6);
  select jc_price into px from public.platform_config limit 1;
  if px is null or px <= 0 then raise exception 'jc price unavailable'; end if;
  select coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0) - private.settlement_reserved_jc(auth.uid()) into jc_bal from public.jc_ledger l where l.user_id = auth.uid();
  if jc_bal < gross then raise exception 'insufficient jc'; end if;
  insert into public.settlement_reservations(request_key, action, user_id, asset_id, quantity, jc_amount, wallet_address, chain_payload)
    values(request_key, 'subscribe', auth.uid(), asset_key, trade_quantity, gross,
      (select p.wallet_address from public.profiles p where p.id = auth.uid()), jsonb_build_object('jc_price', px));
  return jsonb_build_object('request_key', request_key, 'status', 'pending', 'gross', gross, 'total', gross, 'quantity', trade_quantity,
    'entered_secondary_market', a.available - reserved_quantity - trade_quantity = 0);
end;
$function$;
