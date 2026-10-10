-- 二級市場改為 per-order 鏈上託管。
-- 順序：先部署/驗證 contracts/P2PEscrow.sol 並更新前後端合約地址，再審閱並執行本 migration。
-- 本檔不會由 v0 自動套用到 live database。
-- 舊掛單盤點（2026-10-05，套用前即時查詢）：17 筆舊掛單皆已結案，open/partial 為 0。
-- 舊流程沒有預扣 holdings 或 JC；若切換時發現新出現的舊 open/partial 訂單，只記錄並取消，不另產生退款。
-- 舊一次性掛單費保留，歷史與已成交數量不刪除。

begin;

create table if not exists public.p2p_escrow_cutover_audit (
  order_id uuid primary key,
  user_id uuid not null,
  asset_id text not null,
  side text not null,
  status_before text not null,
  remaining_quantity numeric not null,
  cancelled_at timestamptz not null default now(),
  reason text not null default 'legacy order cancelled for escrow cutover'
);

alter table public.p2p_orders
  add column if not exists escrow_mode text not null default 'legacy',
  add column if not exists escrow_request_key text,
  add column if not exists escrow_chain_order_id numeric(78,0),
  add column if not exists escrow_create_tx_hash text,
  add column if not exists escrow_token_address text,
  add column if not exists escrow_currency_address text;

create unique index if not exists p2p_orders_escrow_chain_id_uidx
  on public.p2p_orders (escrow_chain_order_id) where escrow_chain_order_id is not null;
create unique index if not exists p2p_orders_escrow_request_uidx
  on public.p2p_orders (escrow_request_key) where escrow_request_key is not null;

create table if not exists public.p2p_escrow_order_reservations (
  request_key uuid primary key,
  client_order_id text not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  asset_id text not null references public.private_placements(id),
  side text not null check (side in ('buy','sell')),
  price numeric not null check (price > 0),
  quantity numeric not null check (quantity > 0),
  reserved_jc numeric not null check (reserved_jc >= 0),
  status text not null default 'pending' check (status in ('pending','confirmed','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.p2p_escrow_events (
  tx_hash text primary key,
  event_type text not null check (event_type in ('order_created','order_filled','order_cancelled')),
  user_id uuid references public.profiles(id) on delete set null,
  event_data jsonb not null,
  status text not null default 'pending' check (status in ('pending','failed','finalized')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.p2p_escrow_fills (
  fill_key text primary key,
  tx_hash text not null unique,
  chain_order_id numeric(78,0) not null,
  order_id uuid not null references public.p2p_orders(id),
  buyer_id uuid not null references public.profiles(id),
  seller_id uuid not null references public.profiles(id),
  asset_id text not null references public.private_placements(id),
  quantity numeric not null check (quantity > 0),
  price numeric not null check (price > 0),
  gross numeric not null check (gross > 0),
  platform_fee numeric not null check (platform_fee >= 0),
  created_at timestamptz not null default now()
);

alter table public.p2p_escrow_cutover_audit enable row level security;
alter table public.p2p_escrow_order_reservations enable row level security;
alter table public.p2p_escrow_events enable row level security;
alter table public.p2p_escrow_fills enable row level security;

revoke all on public.p2p_escrow_cutover_audit, public.p2p_escrow_order_reservations,
  public.p2p_escrow_events, public.p2p_escrow_fills from anon, authenticated;
grant select on public.p2p_escrow_order_reservations to authenticated;
grant all on public.p2p_escrow_cutover_audit, public.p2p_escrow_order_reservations,
  public.p2p_escrow_events, public.p2p_escrow_fills to service_role;

drop policy if exists p2p_escrow_reservations_read_own on public.p2p_escrow_order_reservations;
create policy p2p_escrow_reservations_read_own
  on public.p2p_escrow_order_reservations for select to authenticated
  using ((select auth.uid()) = user_id);

-- Snapshot active legacy orders for audit and then disable them. Existing historical fills,
-- orders, holdings and ledger entries are preserved. No refund is created because the old
-- order flow did not debit/hold JC or shares when an order was opened.
insert into public.p2p_escrow_cutover_audit(order_id,user_id,asset_id,side,status_before,remaining_quantity)
select o.id,o.user_id,o.asset_id,o.side,o.status,o.remaining_quantity
from public.p2p_orders o
where o.status in ('open','partially_filled')
  and coalesce(o.escrow_mode,'legacy') <> 'escrow'
on conflict (order_id) do nothing;

update public.p2p_orders o
set status='cancelled', updated_at=now()
where o.status in ('open','partially_filled')
  and coalesce(o.escrow_mode,'legacy') <> 'escrow';

-- Never leave the old database-first money-moving endpoints callable by browser sessions.
revoke execute on function public.create_p2p_order(text,text,numeric,numeric,text) from public, anon, authenticated;
revoke execute on function public.fill_p2p_order(uuid,numeric,text) from public, anon, authenticated;
revoke execute on function public.cancel_p2p_order(uuid) from public, anon, authenticated;
revoke execute on function private.settle_p2p_match(uuid,uuid,numeric,text) from public, anon, authenticated;

create or replace function public.get_p2p_order_book(asset_key text default null)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',o.id,'asset_id',o.asset_id,'side',o.side,'price',o.price,
      'original_quantity',o.original_quantity,'remaining_quantity',o.remaining_quantity,
      'status',o.status,'created_at',o.created_at,'is_mine',o.user_id=auth.uid(),
      'escrow_chain_order_id',o.escrow_chain_order_id
    ) order by case when o.side='sell' then o.price end asc,
               case when o.side='buy' then o.price end desc,o.created_at
  ),'[]')
  from public.p2p_orders o
  where auth.uid() is not null and o.status in ('open','partially_filled')
    and o.escrow_mode='escrow'
    and (asset_key is null or o.asset_id=asset_key)
$function$;

create or replace function public.get_my_p2p_orders()
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'asset_id',o.asset_id,'side',o.side,'price',o.price,
    'original_quantity',o.original_quantity,'remaining_quantity',o.remaining_quantity,
    'status',o.status,'created_at',o.created_at,'updated_at',o.updated_at,
    'escrow_chain_order_id',o.escrow_chain_order_id,'escrow_mode',o.escrow_mode,
    'escrow_create_tx_hash',o.escrow_create_tx_hash
  ) order by o.created_at desc),'[]')
  from public.p2p_orders o where o.user_id=auth.uid()
$function$;

revoke all on function public.get_p2p_order_book(text) from public, anon;
grant execute on function public.get_p2p_order_book(text) to authenticated;
revoke all on function public.get_my_p2p_orders() from public, anon;
grant execute on function public.get_my_p2p_orders() to authenticated;

create or replace function public.reserve_p2p_escrow_order(
  p_asset_key text,
  p_side text,
  p_price numeric,
  p_quantity numeric,
  p_request_key uuid,
  p_client_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  a public.private_placements;
  prior public.p2p_escrow_order_reservations;
  fixed_price numeric;
  gross numeric;
  reserve_jc numeric;
  owned numeric;
  reserved_shares numeric;
  jc_balance numeric;
  is_ae boolean;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode='42501'; end if;
  if p_request_key is null or p_client_order_id !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid request key'; end if;
  if p_side not in ('buy','sell') or p_quantity is null or p_quantity<=0 or p_quantity>1000000 then raise exception 'invalid quantity'; end if;

  -- Serialize all reservations for this user so simultaneous tabs cannot reserve the same JC/shares.
  perform 1 from public.profiles where id=auth.uid() for update;
  select * into a from public.private_placements
    where id=p_asset_key and not is_delisted and market_started_at is not null;
  if not found then raise exception 'secondary market unavailable'; end if;
  is_ae := coalesce(a.is_ae_token,false);
  if is_ae then
    if round(p_quantity,6)<>p_quantity then raise exception 'invalid quantity'; end if;
    fixed_price := round(p_price,6);
  else
    if p_quantity<>trunc(p_quantity) then raise exception 'invalid quantity'; end if;
    fixed_price := round(a.price,6);
  end if;
  if fixed_price is null or fixed_price<=0 then raise exception 'invalid price'; end if;
  gross := round(fixed_price*p_quantity,6);
  if gross<2 then raise exception 'minimum trade 2 jc'; end if;
  reserve_jc := case when p_side='sell' then 1 else gross end;

  select * into prior from public.p2p_escrow_order_reservations where request_key=p_request_key;
  if found then
    if prior.user_id<>auth.uid() or prior.asset_id<>p_asset_key or prior.side<>p_side
      or prior.price<>fixed_price or prior.quantity<>p_quantity or prior.client_order_id<>lower(p_client_order_id) then
      raise exception 'request key already used';
    end if;
    return jsonb_build_object('request_key',prior.request_key,'status',prior.status,'reserved_jc',prior.reserved_jc);
  end if;
  if exists(select 1 from public.p2p_escrow_order_reservations r where r.client_order_id=lower(p_client_order_id)) then
    raise exception 'client order id already used';
  end if;
  if exists(select 1 from public.p2p_orders o where o.user_id=auth.uid() and o.asset_id=p_asset_key
      and o.status in ('open','partially_filled') and o.escrow_mode='escrow' and o.side<>p_side)
    or exists(select 1 from public.p2p_escrow_order_reservations r where r.user_id=auth.uid()
      and r.asset_id=p_asset_key and r.status='pending' and r.side<>p_side) then
    raise exception 'opposite side order exists';
  end if;

  if p_side='sell' then
    select coalesce(h.quantity,0) into owned from public.holdings h where h.user_id=auth.uid() and h.asset_id=p_asset_key;
    select coalesce(sum(o.remaining_quantity),0) into reserved_shares from public.p2p_orders o
      where o.user_id=auth.uid() and o.asset_id=p_asset_key and o.side='sell'
        and o.status in ('open','partially_filled') and o.escrow_mode='escrow';
    reserved_shares := reserved_shares + coalesce((select sum(r.quantity) from public.p2p_escrow_order_reservations r
      where r.user_id=auth.uid() and r.asset_id=p_asset_key and r.side='sell' and r.status='pending'),0);
    if coalesce(owned,0)-reserved_shares<p_quantity then raise exception 'insufficient shares'; end if;
  end if;
  select coalesce(sum(l.amount) filter (where l.entry_type<>'commission_pending'),0) into jc_balance
    from public.jc_ledger l where l.user_id=auth.uid();
  if jc_balance<reserve_jc then
    raise exception using message=case when p_side='sell' then 'insufficient listing fee' else 'buyer insufficient balance' end;
  end if;

  insert into public.p2p_escrow_order_reservations(request_key,client_order_id,user_id,asset_id,side,price,quantity,reserved_jc)
    values(p_request_key,lower(p_client_order_id),auth.uid(),p_asset_key,p_side,fixed_price,p_quantity,reserve_jc);
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
    values(auth.uid(),'p2p_order_reserve',-reserve_jc,p_asset_key,'p2p-reserve:'||p_request_key::text,
      jsonb_build_object('request_key',p_request_key,'client_order_id',lower(p_client_order_id),'side',p_side,'quantity',p_quantity,'price',fixed_price));
  return jsonb_build_object('request_key',p_request_key,'status','pending','reserved_jc',reserve_jc);
end
$function$;

create or replace function public.release_p2p_escrow_order_reservation(p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare r public.p2p_escrow_order_reservations;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into r from public.p2p_escrow_order_reservations where request_key=p_request_key for update;
  if not found or r.user_id<>auth.uid() then raise exception 'reservation unavailable'; end if;
  if r.status='released' then return jsonb_build_object('status','released','idempotent',true); end if;
  if r.status<>'pending' then raise exception 'reservation already confirmed'; end if;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
    values(r.user_id,'p2p_order_release',r.reserved_jc,r.asset_id,'p2p-reserve-release:'||p_request_key::text,
      jsonb_build_object('request_key',p_request_key,'reason','order transaction was not submitted'))
    on conflict (idempotency_key) do nothing;
  update public.p2p_escrow_order_reservations set status='released',updated_at=now() where request_key=p_request_key;
  return jsonb_build_object('status','released','amount',r.reserved_jc);
end
$function$;

create or replace function public.confirm_p2p_escrow_order(p_user_id uuid,p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r public.p2p_escrow_order_reservations;
  existing public.p2p_orders;
  order_uuid uuid;
  chain_id numeric(78,0);
  is_sell boolean;
  order_price numeric;
  order_quantity numeric;
  listing_fee numeric;
  fee_row public.jc_ledger;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into r from public.p2p_escrow_order_reservations
    where client_order_id=lower(p_event->>'clientOrderId') for update;
  if not found or r.user_id<>p_user_id then raise exception 'order reservation not found'; end if;
  chain_id := (p_event->>'orderId')::numeric;
  is_sell := (p_event->>'isSell')::boolean;
  order_price := round((p_event->>'price')::numeric/1e18,6);
  order_quantity := (p_event->>'quantity')::numeric/1e18;
  listing_fee := (p_event->>'listingFee')::numeric/1e18;
  if r.status='released' then raise exception 'order reservation has been released'; end if;
  if (case when is_sell then 'sell' else 'buy' end)<>r.side
    or order_price<>r.price or order_quantity<>r.quantity then raise exception 'onchain order does not match reservation'; end if;
  if (is_sell and listing_fee<>1) or (not is_sell and listing_fee<>0) then raise exception 'invalid listing fee'; end if;

  select * into existing from public.p2p_orders where escrow_chain_order_id=chain_id;
  if found then
    if existing.escrow_request_key<>r.request_key::text or existing.user_id<>p_user_id then raise exception 'chain order id already registered'; end if;
    return jsonb_build_object('id',existing.id,'status',existing.status,'idempotent',true);
  end if;
  if r.status='confirmed' then raise exception 'reservation already confirmed without an order'; end if;

  insert into public.p2p_orders(user_id,asset_id,side,price,original_quantity,remaining_quantity,status,
    escrow_mode,escrow_request_key,escrow_chain_order_id,escrow_create_tx_hash,escrow_token_address,escrow_currency_address)
  values(p_user_id,r.asset_id,r.side,r.price,r.quantity,r.quantity,'open','escrow',r.request_key::text,chain_id,
    p_event->>'txHash',lower(p_event->>'assetToken'),lower(p_event->>'currencyToken')) returning * into existing;
  order_uuid := existing.id;
  update public.p2p_escrow_order_reservations set status='confirmed',updated_at=now() where request_key=r.request_key;

  if is_sell then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_order_release',r.reserved_jc,r.asset_id,'p2p-reserve-release:'||r.request_key::text,
        jsonb_build_object('request_key',r.request_key,'reason','listing fee finalized'))
      on conflict (idempotency_key) do nothing;
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_listing_fee',-1,r.asset_id,'escrow-listing-fee:'||chain_id::text,
        jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'kind','listing','tx_hash',p_event->>'txHash'))
      returning * into fee_row;
    insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
      values('p2p_fee',fee_row.id,p_user_id,r.asset_id,1,
        jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'kind','listing','currency','jc','tx_hash',p_event->>'txHash'));
  end if;
  return jsonb_build_object('id',order_uuid,'status','open','chain_order_id',chain_id::text);
end
$function$;

create or replace function public.finalize_p2p_escrow_fill(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  existing_fill public.p2p_escrow_fills;
  o public.p2p_orders;
  buyer_profile public.profiles;
  seller_profile public.profiles;
  v_buyer_id uuid;
  v_seller_id uuid;
  v_fill_key text;
  v_tx_hash text;
  v_chain_id numeric(78,0);
  v_quantity numeric;
  v_price numeric;
  v_gross numeric;
  v_fee numeric;
  v_currency_released numeric;
  v_net numeric;
  buyer_ledger public.jc_ledger;
  seller_ledger public.jc_ledger;
  previous_price numeric;
  price_change numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  v_fill_key := lower(p_event->>'fillKey');
  v_tx_hash := lower(p_event->>'txHash');
  v_chain_id := (p_event->>'orderId')::numeric;
  v_quantity := (p_event->>'quantity')::numeric/1e18;
  v_price := (p_event->>'price')::numeric/1e18;
  v_gross := round((p_event->>'gross')::numeric/1e18,6);
  v_fee := round((p_event->>'fee')::numeric/1e18,6);
  v_currency_released := round((p_event->>'currencyReleased')::numeric/1e18,6);
  v_net := v_gross-v_fee;
  if v_fill_key !~ '^0x[0-9a-f]{64}$' or v_tx_hash !~ '^0x[0-9a-f]{64}$'
    or v_quantity<=0 or v_price<=0 or v_gross<2 or v_fee<0 or v_net<=0
    or round(v_price*v_quantity,6)<>v_gross
    or round(v_gross*0.01,6)<>v_fee then raise exception 'invalid escrow fill'; end if;

  select * into existing_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if existing_fill.tx_hash<>v_tx_hash then raise exception 'fill key already used by another transaction'; end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;

  select * into o from public.p2p_orders where escrow_chain_order_id=v_chain_id for update;
  if not found or o.escrow_mode<>'escrow' or o.status not in ('open','partially_filled')
    or o.remaining_quantity<v_quantity then raise exception 'escrow order no longer matches database'; end if;
  select * into buyer_profile from public.profiles where lower(wallet_address)=lower(p_event->>'buyer');
  select * into seller_profile from public.profiles where lower(wallet_address)=lower(p_event->>'seller');
  if buyer_profile.id is null or seller_profile.id is null or buyer_profile.id=seller_profile.id then raise exception 'trade wallet is not linked to a unique profile'; end if;
  v_buyer_id := buyer_profile.id;
  v_seller_id := seller_profile.id;
  -- Match reservation's profile lock so a taker cannot spend JC in a fill while
  -- concurrently reserving the same balance for another buy order.
  perform 1 from public.profiles where id in (v_buyer_id,v_seller_id) order by id for update;
  if (o.side='sell' and o.user_id<>v_seller_id) or (o.side='buy' and o.user_id<>v_buyer_id)
    or o.price<>v_price
    or lower(o.escrow_token_address)<>lower(p_event->>'assetToken')
    or lower(o.escrow_currency_address)<>lower(p_event->>'currencyToken')
    or (o.side='buy' and v_currency_released<v_gross)
    or (o.side='sell' and v_currency_released<>0) then raise exception 'chain trade does not match database order'; end if;

  insert into public.p2p_escrow_fills(fill_key,tx_hash,chain_order_id,order_id,buyer_id,seller_id,asset_id,quantity,price,gross,platform_fee)
    values(v_fill_key,v_tx_hash,v_chain_id,o.id,v_buyer_id,v_seller_id,o.asset_id,v_quantity,v_price,v_gross,v_fee);

  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(v_buyer_id,'p2p_buy',-v_gross,o.asset_id,v_quantity,'escrow-fill:'||v_fill_key||':buyer',
      jsonb_build_object('gross',v_gross,'order_id',o.id,'chain_order_id',v_chain_id,'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_seller_id,'escrow',true))
    returning * into buyer_ledger;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(v_seller_id,'p2p_sell',v_net,o.asset_id,-v_quantity,'escrow-fill:'||v_fill_key||':seller',
      jsonb_build_object('gross',v_gross,'fee',v_fee,'order_id',o.id,'chain_order_id',v_chain_id,'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_buyer_id,'escrow',true))
    returning * into seller_ledger;

  -- Convert the buyer's existing order reservation into the actual purchase and unlock only
  -- the exact currency amount returned by the chain event (including any final rounding refund).
  if o.side='buy' then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(v_buyer_id,'p2p_order_release',v_currency_released,o.asset_id,'escrow-fill:'||v_fill_key||':reserve-release',
        jsonb_build_object('order_id',o.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade'));
  end if;

  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(v_buyer_id,o.asset_id,v_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(v_seller_id,o.asset_id,-v_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();

  update public.p2p_orders set remaining_quantity=remaining_quantity-v_quantity,
    status=case when remaining_quantity-v_quantity=0 then 'filled' else 'partially_filled' end,
    updated_at=now() where id=o.id;
  insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
    values('p2p_fee',seller_ledger.id,v_seller_id,o.asset_id,v_fee,
      jsonb_build_object('order_id',o.id,'chain_order_id',v_chain_id,'fill_key',v_fill_key,'gross',v_gross,'currency','jc','tx_hash',v_tx_hash));
  perform private.post_referral_commissions(v_seller_id,o.asset_id,'secondary',v_gross,seller_ledger.id,'escrow-fill:'||v_fill_key||':commission');
  select mps.price into previous_price from public.market_price_snapshots mps where mps.asset_id=o.asset_id order by mps.recorded_at desc limit 1;
  insert into public.market_price_snapshots(asset_id,price,recorded_by) values(o.asset_id,v_price,v_buyer_id);
  price_change := case when previous_price is null or previous_price=0 then 0 else round((v_price-previous_price)/previous_price*100,4) end;
  update public.private_placements set last_traded_price=v_price,change=price_change,updated_at=now() where id=o.asset_id;
  return jsonb_build_object('status','confirmed','fill_key',v_fill_key,'gross',v_gross,'fee',v_fee,'net',v_net);
end
$function$;

create or replace function public.finalize_p2p_escrow_cancel(p_user_id uuid,p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  o public.p2p_orders;
  chain_id numeric(78,0);
  refund_amount numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  chain_id := (p_event->>'orderId')::numeric;
  select * into o from public.p2p_orders where escrow_chain_order_id=chain_id for update;
  if not found or o.user_id<>p_user_id or o.escrow_mode<>'escrow' then raise exception 'escrow order not found'; end if;
  if o.status='cancelled' then return jsonb_build_object('status','cancelled','idempotent',true); end if;
  if o.status='filled' and coalesce((p_event->>'refundedAmount')::numeric,0)=0 then
    return jsonb_build_object('status','filled','idempotent',true);
  end if;
  if o.status not in ('open','partially_filled') then raise exception 'order is no longer cancellable'; end if;
  if o.side='buy' then
    refund_amount := round((p_event->>'refundedAmount')::numeric/1e18,6);
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(o.user_id,'p2p_order_release',refund_amount,o.asset_id,'escrow-cancel:'||chain_id::text,
        jsonb_build_object('order_id',o.id,'chain_order_id',chain_id,'tx_hash',p_event->>'txHash','reason','unfilled buy-order escrow refunded'));
  end if;
  update public.p2p_orders set status='cancelled',remaining_quantity=0,updated_at=now() where id=o.id;
  return jsonb_build_object('status','cancelled','refunded_jc',coalesce(refund_amount,0));
end
$function$;

revoke all on function public.reserve_p2p_escrow_order(text,text,numeric,numeric,uuid,text) from public, anon;
grant execute on function public.reserve_p2p_escrow_order(text,text,numeric,numeric,uuid,text) to authenticated;
revoke all on function public.release_p2p_escrow_order_reservation(uuid) from public, anon;
grant execute on function public.release_p2p_escrow_order_reservation(uuid) to authenticated;
revoke all on function public.confirm_p2p_escrow_order(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.confirm_p2p_escrow_order(uuid,jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_fill(jsonb) from public, anon, authenticated;
grant execute on function public.finalize_p2p_escrow_fill(jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_cancel(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.finalize_p2p_escrow_cancel(uuid,jsonb) to service_role;

commit;
