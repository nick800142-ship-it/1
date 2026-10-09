begin;

alter table public.p2p_orders
  add column if not exists escrow_contract_address text;

-- The previous escrow deployment was replaced on 2026-10-07. Its order IDs restart at 1,
-- so preserve old rows under their original contract instead of treating the ID as global.
update public.p2p_orders
set escrow_contract_address = '0xa9041563e103fb9dd6cd15859a1dab465c2c7c28'
where escrow_mode = 'escrow'
  and escrow_chain_order_id is not null
  and escrow_contract_address is null;

drop index if exists public.p2p_orders_escrow_chain_id_uidx;
create unique index if not exists p2p_orders_escrow_contract_chain_id_uidx
  on public.p2p_orders (escrow_contract_address, escrow_chain_order_id)
  where escrow_contract_address is not null and escrow_chain_order_id is not null;

create or replace function private.escrow_event_contract(p_event jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select lower(coalesce(
    nullif(p_event->>'escrowContract', ''),
    '0xbfb3456226ca1e46cf2bdb3b2d42619a2b7b8db0'
  ))
$function$;

drop function if exists public.get_p2p_order_book(text);
create or replace function public.get_p2p_order_book(
  asset_key text default null,
  p_escrow_contract_address text default '0xbfb3456226ca1e46cf2bdb3b2d42619a2b7b8db0'
)
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
      'escrow_chain_order_id',o.escrow_chain_order_id,
      'escrow_contract_address',o.escrow_contract_address
    ) order by case when o.side='sell' then o.price end asc,
               case when o.side='buy' then o.price end desc,o.created_at
  ),'[]')
  from public.p2p_orders o
  where auth.uid() is not null
    and o.status in ('open','partially_filled')
    and o.escrow_mode='escrow'
    and lower(o.escrow_contract_address)=lower(p_escrow_contract_address)
    and (asset_key is null or o.asset_id=asset_key)
$function$;

drop function if exists public.get_my_p2p_orders();
create or replace function public.get_my_p2p_orders(
  p_escrow_contract_address text default '0xbfb3456226ca1e46cf2bdb3b2d42619a2b7b8db0'
)
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
    'escrow_create_tx_hash',o.escrow_create_tx_hash,
    'escrow_contract_address',o.escrow_contract_address
  ) order by o.created_at desc),'[]')
  from public.p2p_orders o
  where o.user_id=auth.uid()
    and (o.escrow_mode is distinct from 'escrow'
      or lower(o.escrow_contract_address)=lower(p_escrow_contract_address))
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
  escrow_contract text;
  fee_row public.jc_ledger;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  select * into r from public.p2p_escrow_order_reservations
    where client_order_id=lower(p_event->>'clientOrderId') for update;
  if not found or r.user_id<>p_user_id then raise exception 'order reservation not found'; end if;
  chain_id := (p_event->>'orderId')::numeric;
  escrow_contract := private.escrow_event_contract(p_event);
  if escrow_contract !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid escrow contract address'; end if;
  is_sell := (p_event->>'isSell')::boolean;
  order_price := round((p_event->>'price')::numeric/1e18,6);
  order_quantity := (p_event->>'quantity')::numeric/1e18;
  listing_fee := (p_event->>'listingFee')::numeric/1e18;
  if r.status='released' then raise exception 'order reservation has been released'; end if;
  if (case when is_sell then 'sell' else 'buy' end)<>r.side
    or order_price<>r.price or order_quantity<>r.quantity then raise exception 'onchain order does not match reservation'; end if;
  if (is_sell and listing_fee<>1) or (not is_sell and listing_fee<>0) then raise exception 'invalid listing fee'; end if;

  select * into existing from public.p2p_orders
    where escrow_chain_order_id=chain_id and escrow_contract_address=escrow_contract;
  if found then
    if existing.escrow_request_key<>r.request_key::text or existing.user_id<>p_user_id then
      raise exception 'chain order id already registered for this escrow contract';
    end if;
    return jsonb_build_object('id',existing.id,'status',existing.status,'idempotent',true);
  end if;
  if r.status='confirmed' then raise exception 'reservation already confirmed without an order'; end if;

  insert into public.p2p_orders(
    user_id,asset_id,side,price,original_quantity,remaining_quantity,status,
    escrow_mode,escrow_request_key,escrow_chain_order_id,escrow_contract_address,
    escrow_create_tx_hash,escrow_token_address,escrow_currency_address,escrow_locked_currency
  ) values (
    p_user_id,r.asset_id,r.side,r.price,r.quantity,r.quantity,'open',
    'escrow',r.request_key::text,chain_id,escrow_contract,
    p_event->>'txHash',lower(p_event->>'assetToken'),lower(p_event->>'currencyToken'),
    case when is_sell then 0 else round(r.price * r.quantity, 6) end
  ) returning * into existing;
  order_uuid := existing.id;
  update public.p2p_escrow_order_reservations set status='confirmed',updated_at=now()
    where request_key=r.request_key;

  if is_sell then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_order_release',r.reserved_jc,r.asset_id,
        'p2p-reserve-release:'||r.request_key::text,
        jsonb_build_object('request_key',r.request_key,'reason','listing fee finalized'))
      on conflict (idempotency_key) do nothing;
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_listing_fee',-1,r.asset_id,'escrow-listing-fee:'||escrow_contract||':'||chain_id::text,
        jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'escrow_contract',escrow_contract,
          'kind','listing','tx_hash',p_event->>'txHash'))
      returning * into fee_row;
    insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
      values('p2p_fee',fee_row.id,p_user_id,r.asset_id,1,
        jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'escrow_contract',escrow_contract,
          'kind','listing','currency','jc','tx_hash',p_event->>'txHash'));
  end if;
  return jsonb_build_object('id',order_uuid,'status','open','chain_order_id',chain_id::text);
end
$function$;

create or replace function private.validate_p2p_auto_match(p_event jsonb)
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select b.id
  from public.p2p_orders s
  join public.p2p_orders b
    on b.escrow_chain_order_id=(p_event->>'counterOrderId')::numeric
   and b.escrow_contract_address=private.escrow_event_contract(p_event)
  where s.escrow_chain_order_id=(p_event->>'orderId')::numeric
    and s.escrow_contract_address=private.escrow_event_contract(p_event)
    and s.escrow_mode='escrow' and b.escrow_mode='escrow'
    and s.side='sell' and b.side='buy'
    and s.status in ('open','partially_filled') and b.status in ('open','partially_filled')
    and s.remaining_quantity >= (p_event->>'quantity')::numeric/1e18
    and b.remaining_quantity >= (p_event->>'quantity')::numeric/1e18
    and s.user_id<>b.user_id and s.asset_id=b.asset_id and s.price<=b.price
    and lower(s.escrow_token_address)=lower(p_event->>'assetToken')
    and lower(b.escrow_token_address)=lower(p_event->>'assetToken')
    and lower(s.escrow_currency_address)=lower(p_event->>'currencyToken')
    and lower(b.escrow_currency_address)=lower(p_event->>'currencyToken')
    and (p_event->>'price')::numeric/1e18=case when s.escrow_chain_order_id<b.escrow_chain_order_id then b.price else s.price end
    and round((p_event->>'currencyReleased')::numeric/1e18,6)=case
      when (p_event->>'quantity')::numeric/1e18=b.remaining_quantity then b.escrow_locked_currency
      else round((p_event->>'gross')::numeric/1e18,6) end
    and round((p_event->>'currencyReleased')::numeric/1e18,6)<=b.escrow_locked_currency
    and exists(select 1 from public.profiles p where p.id=b.user_id and lower(p.wallet_address)=lower(p_event->>'buyer'))
    and exists(select 1 from public.profiles p where p.id=s.user_id and lower(p.wallet_address)=lower(p_event->>'seller'))
  for update of s,b
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
  v_escrow_contract text;
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
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  v_fill_key := lower(p_event->>'fillKey');
  v_tx_hash := lower(p_event->>'txHash');
  v_chain_id := (p_event->>'orderId')::numeric;
  v_escrow_contract := private.escrow_event_contract(p_event);
  if v_escrow_contract !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid escrow contract address'; end if;
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

  select * into o from public.p2p_orders
    where escrow_chain_order_id=v_chain_id and escrow_contract_address=v_escrow_contract for update;
  if not found or o.escrow_mode<>'escrow' or o.status not in ('open','partially_filled')
    or o.remaining_quantity<v_quantity then raise exception 'escrow order no longer matches database'; end if;
  select * into buyer_profile from public.profiles where lower(wallet_address)=lower(p_event->>'buyer');
  select * into seller_profile from public.profiles where lower(wallet_address)=lower(p_event->>'seller');
  if buyer_profile.id is null or seller_profile.id is null or buyer_profile.id=seller_profile.id then
    raise exception 'trade wallet is not linked to a unique profile';
  end if;
  v_buyer_id := buyer_profile.id;
  v_seller_id := seller_profile.id;
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
      jsonb_build_object('gross',v_gross,'order_id',o.id,'chain_order_id',v_chain_id,'escrow_contract',v_escrow_contract,
        'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_seller_id,'escrow',true))
    returning * into buyer_ledger;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(v_seller_id,'p2p_sell',v_net,o.asset_id,-v_quantity,'escrow-fill:'||v_fill_key||':seller',
      jsonb_build_object('gross',v_gross,'fee',v_fee,'order_id',o.id,'chain_order_id',v_chain_id,'escrow_contract',v_escrow_contract,
        'fill_key',v_fill_key,'tx_hash',v_tx_hash,'counterparty_id',v_buyer_id,'escrow',true))
    returning * into seller_ledger;
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
    status=case when remaining_quantity-v_quantity=0 then 'filled' else 'partially_filled' end,updated_at=now() where id=o.id;
  insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
    values('p2p_fee',seller_ledger.id,v_seller_id,o.asset_id,v_fee,
      jsonb_build_object('order_id',o.id,'chain_order_id',v_chain_id,'escrow_contract',v_escrow_contract,
        'fill_key',v_fill_key,'gross',v_gross,'currency','jc','tx_hash',v_tx_hash));
  perform private.post_referral_commissions(v_seller_id,o.asset_id,'secondary',v_gross,seller_ledger.id,'escrow-fill:'||v_fill_key||':commission');
  select mps.price into previous_price from public.market_price_snapshots mps where mps.asset_id=o.asset_id order by mps.recorded_at desc limit 1;
  insert into public.market_price_snapshots(asset_id,price,recorded_by) values(o.asset_id,v_price,v_buyer_id);
  price_change := case when previous_price is null or previous_price=0 then 0 else round((v_price-previous_price)/previous_price*100,4) end;
  update public.private_placements set last_traded_price=v_price,change=price_change,updated_at=now() where id=o.asset_id;
  return jsonb_build_object('status','confirmed','fill_key',v_fill_key,'gross',v_gross,'fee',v_fee,'net',v_net);
end
$function$;

create or replace function public.finalize_p2p_escrow_auto_match(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  old_fill public.p2p_escrow_fills;
  b public.p2p_orders;
  buy_uuid uuid;
  v_fill_key text;
  v_tx_hash text;
  qty numeric;
  released numeric;
  result jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  v_fill_key:=lower(p_event->>'fillKey');
  v_tx_hash:=lower(p_event->>'txHash');
  qty:=(p_event->>'quantity')::numeric/1e18;
  released:=round((p_event->>'currencyReleased')::numeric/1e18,6);
  select * into old_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if old_fill.tx_hash<>v_tx_hash or old_fill.counter_chain_order_id is distinct from (p_event->>'counterOrderId')::numeric then
      raise exception 'fill key already used by another transaction';
    end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;
  buy_uuid:=private.validate_p2p_auto_match(p_event);
  if buy_uuid is null then raise exception 'automatic chain fill does not match both database orders'; end if;
  select * into b from public.p2p_orders where id=buy_uuid;
  select * into old_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if old_fill.tx_hash<>v_tx_hash or old_fill.counter_chain_order_id is distinct from (p_event->>'counterOrderId')::numeric then
      raise exception 'fill key already used by another transaction';
    end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;
  result:=public.finalize_p2p_escrow_fill(p_event || jsonb_build_object('counterOrderId','0','currencyReleased','0'));
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
    values(b.user_id,'p2p_order_release',released,b.asset_id,'escrow-fill:'||v_fill_key||':reserve-release',
      jsonb_build_object('order_id',b.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade'));
  update public.p2p_orders set remaining_quantity=remaining_quantity-qty,escrow_locked_currency=escrow_locked_currency-released,
    status=case when remaining_quantity-qty=0 then 'filled' else 'partially_filled' end,updated_at=now() where id=b.id;
  update public.p2p_escrow_fills f set counter_chain_order_id=(p_event->>'counterOrderId')::numeric,counter_order_id=b.id
    where f.fill_key=v_fill_key and f.tx_hash=v_tx_hash;
  return result || jsonb_build_object('buy_order_id',b.id,'automatic',true);
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
  escrow_contract text;
  refund_amount numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  chain_id := (p_event->>'orderId')::numeric;
  escrow_contract := private.escrow_event_contract(p_event);
  if escrow_contract !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid escrow contract address'; end if;
  select * into o from public.p2p_orders
    where escrow_chain_order_id=chain_id and escrow_contract_address=escrow_contract for update;
  if not found or o.user_id<>p_user_id or o.escrow_mode<>'escrow' then raise exception 'escrow order not found'; end if;
  if o.status='cancelled' then
    update public.p2p_orders set escrow_locked_currency=0 where id=o.id;
    return jsonb_build_object('status','cancelled','idempotent',true);
  end if;
  if o.status='filled' and coalesce((p_event->>'refundedAmount')::numeric,0)=0 then
    update public.p2p_orders set escrow_locked_currency=0 where id=o.id;
    return jsonb_build_object('status','filled','idempotent',true);
  end if;
  if o.status not in ('open','partially_filled') then raise exception 'order is no longer cancellable'; end if;
  if o.side='buy' then
    refund_amount := round((p_event->>'refundedAmount')::numeric/1e18,6);
    if refund_amount<>o.escrow_locked_currency then raise exception 'cancel refund does not match locked JC'; end if;
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(o.user_id,'p2p_order_release',refund_amount,o.asset_id,'escrow-cancel:'||escrow_contract||':'||chain_id::text,
        jsonb_build_object('order_id',o.id,'chain_order_id',chain_id,'escrow_contract',escrow_contract,
          'tx_hash',p_event->>'txHash','reason','unfilled buy-order escrow refunded'));
  end if;
  update public.p2p_orders set status='cancelled',remaining_quantity=0,escrow_locked_currency=0,updated_at=now() where id=o.id;
  return jsonb_build_object('status','cancelled','refunded_jc',coalesce(refund_amount,0));
end
$function$;

revoke all on function private.escrow_event_contract(jsonb) from public,anon,authenticated;
grant execute on function private.escrow_event_contract(jsonb) to service_role;
revoke all on function private.validate_p2p_auto_match(jsonb) from public,anon,authenticated;
grant execute on function private.validate_p2p_auto_match(jsonb) to service_role;
revoke all on function public.get_p2p_order_book(text,text) from public,anon;
grant execute on function public.get_p2p_order_book(text,text) to authenticated;
revoke all on function public.get_my_p2p_orders(text) from public,anon;
grant execute on function public.get_my_p2p_orders(text) to authenticated;
revoke all on function public.confirm_p2p_escrow_order(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.confirm_p2p_escrow_order(uuid,jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_fill(jsonb) from public,anon,authenticated;
grant execute on function public.finalize_p2p_escrow_fill(jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_auto_match(jsonb) from public,anon,authenticated;
grant execute on function public.finalize_p2p_escrow_auto_match(jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_cancel(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_p2p_escrow_cancel(uuid,jsonb) to service_role;

commit;

notify pgrst, 'reload schema';

select has_function_privilege('authenticated','public.finalize_p2p_escrow_fill(jsonb)','EXECUTE') as authenticated_can_finalize;
select has_function_privilege('service_role','public.finalize_p2p_escrow_fill(jsonb)','EXECUTE') as service_role_can_finalize;
select indexdef from pg_indexes where schemaname='public' and indexname='p2p_orders_escrow_contract_chain_id_uidx';
select escrow_contract_address,escrow_chain_order_id,status from public.p2p_orders where escrow_mode='escrow' order by created_at;
