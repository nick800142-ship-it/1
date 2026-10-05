-- Price-time automatic matching for P2PEscrow.
-- Apply only after deploying the replacement escrow contract and updating the app address.
begin;

alter table public.p2p_orders
  add column if not exists escrow_locked_currency numeric not null default 0;

update public.p2p_orders
set escrow_locked_currency = case
  when side = 'buy' and status in ('open','partially_filled')
    then round(price * remaining_quantity, 6)
  else 0
end
where escrow_mode = 'escrow';

alter table public.p2p_escrow_fills
  add column if not exists counter_chain_order_id numeric(78,0),
  add column if not exists counter_order_id uuid references public.p2p_orders(id);

create index if not exists p2p_escrow_auto_match_book_idx
  on public.p2p_orders(asset_id, side, price, created_at)
  where escrow_mode='escrow' and status in ('open','partially_filled');

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
    escrow_mode,escrow_request_key,escrow_chain_order_id,escrow_create_tx_hash,escrow_token_address,
    escrow_currency_address,escrow_locked_currency)
  values(p_user_id,r.asset_id,r.side,r.price,r.quantity,r.quantity,'open','escrow',r.request_key::text,chain_id,
    p_event->>'txHash',lower(p_event->>'assetToken'),lower(p_event->>'currencyToken'),
    case when is_sell then 0 else r.reserved_jc end) returning * into existing;
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
  sell_order public.p2p_orders;
  buy_order public.p2p_orders;
  primary_order public.p2p_orders;
  buyer_profile public.profiles;
  seller_profile public.profiles;
  v_buyer_id uuid;
  v_seller_id uuid;
  v_fill_key text;
  v_tx_hash text;
  v_sell_chain_id numeric(78,0);
  v_buy_chain_id numeric(78,0);
  v_quantity numeric;
  v_price numeric;
  v_gross numeric;
  v_fee numeric;
  v_currency_released numeric;
  v_net numeric;
  v_asset_id text;
  v_auto_match boolean;
  buyer_ledger public.jc_ledger;
  seller_ledger public.jc_ledger;
  previous_price numeric;
  price_change numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  v_fill_key := lower(p_event->>'fillKey');
  v_tx_hash := lower(p_event->>'txHash');
  v_sell_chain_id := (p_event->>'orderId')::numeric;
  v_buy_chain_id := coalesce(nullif(p_event->>'counterOrderId','')::numeric,0);
  v_auto_match := v_buy_chain_id<>0;
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

  if v_auto_match then
    perform 1 from public.p2p_orders
      where escrow_chain_order_id in (v_sell_chain_id,v_buy_chain_id)
      order by escrow_chain_order_id for update;
    select * into sell_order from public.p2p_orders where escrow_chain_order_id=v_sell_chain_id;
    select * into buy_order from public.p2p_orders where escrow_chain_order_id=v_buy_chain_id;
    if sell_order.id is null or buy_order.id is null
      or sell_order.escrow_mode<>'escrow' or buy_order.escrow_mode<>'escrow'
      or sell_order.side<>'sell' or buy_order.side<>'buy'
      or sell_order.status not in ('open','partially_filled')
      or buy_order.status not in ('open','partially_filled')
      or sell_order.remaining_quantity<v_quantity or buy_order.remaining_quantity<v_quantity
      or sell_order.user_id=buy_order.user_id
      or sell_order.asset_id<>buy_order.asset_id
      or sell_order.price>buy_order.price
      or lower(sell_order.escrow_token_address)<>lower(p_event->>'assetToken')
      or lower(buy_order.escrow_token_address)<>lower(p_event->>'assetToken')
      or lower(sell_order.escrow_currency_address)<>lower(p_event->>'currencyToken')
      or lower(buy_order.escrow_currency_address)<>lower(p_event->>'currencyToken')
      or v_price<>case when v_sell_chain_id<v_buy_chain_id then buy_order.price else sell_order.price end
      or v_currency_released<>case when v_quantity=buy_order.remaining_quantity then buy_order.escrow_locked_currency else v_gross end
      or v_currency_released>buy_order.escrow_locked_currency then
      raise exception 'automatic chain fill does not match both database orders';
    end if;
    primary_order := sell_order;
    v_buyer_id := buy_order.user_id;
    v_seller_id := sell_order.user_id;
    v_asset_id := sell_order.asset_id;
  else
    select * into primary_order from public.p2p_orders
      where escrow_chain_order_id=v_sell_chain_id for update;
    if not found or primary_order.escrow_mode<>'escrow'
      or primary_order.status not in ('open','partially_filled')
      or primary_order.remaining_quantity<v_quantity then raise exception 'escrow order no longer matches database'; end if;
    select * into buyer_profile from public.profiles where lower(wallet_address)=lower(p_event->>'buyer');
    select * into seller_profile from public.profiles where lower(wallet_address)=lower(p_event->>'seller');
    if buyer_profile.id is null or seller_profile.id is null or buyer_profile.id=seller_profile.id then raise exception 'trade wallet is not linked to a unique profile'; end if;
    v_buyer_id := buyer_profile.id;
    v_seller_id := seller_profile.id;
    if (primary_order.side='sell' and primary_order.user_id<>v_seller_id)
      or (primary_order.side='buy' and primary_order.user_id<>v_buyer_id)
      or primary_order.price<>v_price
      or lower(primary_order.escrow_token_address)<>lower(p_event->>'assetToken')
      or lower(primary_order.escrow_currency_address)<>lower(p_event->>'currencyToken')
      or (primary_order.side='buy' and v_currency_released<v_gross)
      or (primary_order.side='sell' and v_currency_released<>0) then
      raise exception 'chain trade does not match database order';
    end if;
    v_asset_id := primary_order.asset_id;
    if primary_order.side='sell' then sell_order := primary_order; else buy_order := primary_order; end if;
  end if;

  select * into buyer_profile from public.profiles where id=v_buyer_id;
  select * into seller_profile from public.profiles where id=v_seller_id;
  if lower(buyer_profile.wallet_address)<>lower(p_event->>'buyer')
    or lower(seller_profile.wallet_address)<>lower(p_event->>'seller') then raise exception 'event wallets do not match order owners'; end if;
  perform 1 from public.profiles where id in (v_buyer_id,v_seller_id) order by id for update;

  insert into public.p2p_escrow_fills(fill_key,tx_hash,chain_order_id,order_id,buyer_id,seller_id,asset_id,quantity,price,gross,platform_fee,
    counter_chain_order_id,counter_order_id)
  values(v_fill_key,v_tx_hash,v_sell_chain_id,primary_order.id,v_buyer_id,v_seller_id,v_asset_id,v_quantity,v_price,v_gross,v_fee,
    case when v_auto_match then v_buy_chain_id else null end,case when v_auto_match then buy_order.id else null end);

  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(v_buyer_id,'p2p_buy',-v_gross,v_asset_id,v_quantity,'escrow-fill:'||v_fill_key||':buyer',
      jsonb_build_object('gross',v_gross,'order_id',primary_order.id,'buy_order_id',buy_order.id,'chain_order_id',v_sell_chain_id,
        'counter_chain_order_id',case when v_auto_match then v_buy_chain_id else null end,'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_seller_id,'escrow',true))
    returning * into buyer_ledger;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(v_seller_id,'p2p_sell',v_net,v_asset_id,-v_quantity,'escrow-fill:'||v_fill_key||':seller',
      jsonb_build_object('gross',v_gross,'fee',v_fee,'order_id',primary_order.id,'buy_order_id',buy_order.id,'chain_order_id',v_sell_chain_id,
        'counter_chain_order_id',case when v_auto_match then v_buy_chain_id else null end,'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_buyer_id,'escrow',true))
    returning * into seller_ledger;

  if v_auto_match then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(v_buyer_id,'p2p_order_release',v_currency_released,v_asset_id,'escrow-fill:'||v_fill_key||':reserve-release',
        jsonb_build_object('order_id',buy_order.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade'));
    update public.p2p_orders set remaining_quantity=remaining_quantity-v_quantity,
      escrow_locked_currency=escrow_locked_currency-v_currency_released,
      status=case when remaining_quantity-v_quantity=0 then 'filled' else 'partially_filled' end,
      updated_at=now() where id=buy_order.id;
    update public.p2p_orders set remaining_quantity=remaining_quantity-v_quantity,
      status=case when remaining_quantity-v_quantity=0 then 'filled' else 'partially_filled' end,
      updated_at=now() where id=sell_order.id;
  else
    if primary_order.side='buy' then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
        values(v_buyer_id,'p2p_order_release',v_currency_released,v_asset_id,'escrow-fill:'||v_fill_key||':reserve-release',
          jsonb_build_object('order_id',primary_order.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade'));
      update public.p2p_orders set escrow_locked_currency=escrow_locked_currency-v_currency_released where id=primary_order.id;
    end if;
    update public.p2p_orders set remaining_quantity=remaining_quantity-v_quantity,
      status=case when remaining_quantity-v_quantity=0 then 'filled' else 'partially_filled' end,
      updated_at=now() where id=primary_order.id;
  end if;

  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(v_buyer_id,v_asset_id,v_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(v_seller_id,v_asset_id,-v_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();

  insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
    values('p2p_fee',seller_ledger.id,v_seller_id,v_asset_id,v_fee,
      jsonb_build_object('order_id',primary_order.id,'buy_order_id',buy_order.id,'chain_order_id',v_sell_chain_id,
        'counter_chain_order_id',case when v_auto_match then v_buy_chain_id else null end,'fill_key',v_fill_key,'gross',v_gross,'currency','jc','tx_hash',v_tx_hash));
  perform private.post_referral_commissions(v_seller_id,v_asset_id,'secondary',v_gross,seller_ledger.id,'escrow-fill:'||v_fill_key||':commission');
  select mps.price into previous_price from public.market_price_snapshots mps where mps.asset_id=v_asset_id order by mps.recorded_at desc limit 1;
  insert into public.market_price_snapshots(asset_id,price,recorded_by) values(v_asset_id,v_price,v_buyer_id);
  price_change := case when previous_price is null or previous_price=0 then 0 else round((v_price-previous_price)/previous_price*100,4) end;
  update public.private_placements set last_traded_price=v_price,change=price_change,updated_at=now() where id=v_asset_id;
  return jsonb_build_object('status','confirmed','fill_key',v_fill_key,'gross',v_gross,'fee',v_fee,'net',v_net,
    'buy_order_id',buy_order.id,'sell_order_id',sell_order.id,'idempotent',false);
end
$function$;

revoke all on function public.confirm_p2p_escrow_order(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.confirm_p2p_escrow_order(uuid,jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_fill(jsonb) from public, anon, authenticated;
grant execute on function public.finalize_p2p_escrow_fill(jsonb) to service_role;

commit;

-- After applying this migration, verify that only service_role can finalize a fill and that
-- all auto-matches persist both chain order ids and update both order rows atomically.
SELECT has_function_privilege('authenticated', 'public.finalize_p2p_escrow_fill(jsonb)', 'EXECUTE') AS authenticated_can_finalize;
SELECT has_function_privilege('service_role', 'public.finalize_p2p_escrow_fill(jsonb)', 'EXECUTE') AS service_role_can_finalize;
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='p2p_escrow_fills'
  AND column_name IN ('counter_chain_order_id','counter_order_id');
