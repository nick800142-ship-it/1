-- Price-time automatic matching for P2PEscrow.
-- Apply after deploying the replacement escrow contract and updating both app address sources.
begin;

alter table public.p2p_orders
  add column if not exists escrow_locked_currency numeric not null default 0;

update public.p2p_orders
set escrow_locked_currency = case
  when side = 'buy' and status in ('open','partially_filled') then round(price * remaining_quantity, 6)
  else 0
end
where escrow_mode = 'escrow';

alter table public.p2p_escrow_fills
  add column if not exists counter_chain_order_id numeric(78,0),
  add column if not exists counter_order_id uuid references public.p2p_orders(id);

create index if not exists p2p_escrow_fills_counter_order_idx
  on public.p2p_escrow_fills(counter_order_id) where counter_order_id is not null;

create index if not exists p2p_escrow_auto_match_book_idx
  on public.p2p_orders(asset_id, side, price, created_at)
  where escrow_mode='escrow' and status in ('open','partially_filled');

create or replace function public.confirm_p2p_escrow_order(p_user_id uuid,p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
  if coalesce(auth.jwt() ->> 'role',current_setting('request.jwt.claim.role',true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  select * into r from public.p2p_escrow_order_reservations where client_order_id=lower(p_event->>'clientOrderId') for update;
  if not found or r.user_id<>p_user_id then raise exception 'order reservation not found'; end if;
  chain_id:=(p_event->>'orderId')::numeric;
  is_sell:=(p_event->>'isSell')::boolean;
  order_price:=round((p_event->>'price')::numeric/1e18,6);
  order_quantity:=(p_event->>'quantity')::numeric/1e18;
  listing_fee:=(p_event->>'listingFee')::numeric/1e18;
  if r.status='released' then raise exception 'order reservation has been released'; end if;
  if (case when is_sell then 'sell' else 'buy' end)<>r.side or order_price<>r.price or order_quantity<>r.quantity then raise exception 'onchain order does not match reservation'; end if;
  if (is_sell and listing_fee<>1) or (not is_sell and listing_fee<>0) then raise exception 'invalid listing fee'; end if;
  select * into existing from public.p2p_orders where escrow_chain_order_id=chain_id;
  if found then
    if existing.escrow_request_key<>r.request_key::text or existing.user_id<>p_user_id then raise exception 'chain order id already registered'; end if;
    return jsonb_build_object('id',existing.id,'status',existing.status,'idempotent',true);
  end if;
  if r.status='confirmed' then raise exception 'reservation already confirmed without an order'; end if;
  insert into public.p2p_orders(user_id,asset_id,side,price,original_quantity,remaining_quantity,status,escrow_mode,escrow_request_key,escrow_chain_order_id,escrow_create_tx_hash,escrow_token_address,escrow_currency_address,escrow_locked_currency)
  values(p_user_id,r.asset_id,r.side,r.price,r.quantity,r.quantity,'open','escrow',r.request_key::text,chain_id,p_event->>'txHash',lower(p_event->>'assetToken'),lower(p_event->>'currencyToken'),case when is_sell then 0 else r.reserved_jc end) returning * into existing;
  order_uuid:=existing.id;
  update public.p2p_escrow_order_reservations set status='confirmed',updated_at=now() where request_key=r.request_key;
  if is_sell then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_order_release',r.reserved_jc,r.asset_id,'p2p-reserve-release:'||r.request_key::text,jsonb_build_object('request_key',r.request_key,'reason','listing fee finalized'))
      on conflict (idempotency_key) do nothing;
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_listing_fee',-1,r.asset_id,'escrow-listing-fee:'||chain_id::text,jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'kind','listing','tx_hash',p_event->>'txHash'))
      returning * into fee_row;
    insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
      values('p2p_fee',fee_row.id,p_user_id,r.asset_id,1,jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'kind','listing','currency','jc','tx_hash',p_event->>'txHash'));
  end if;
  return jsonb_build_object('id',order_uuid,'status','open','chain_order_id',chain_id::text);
end;
$function$;

-- Lock and validate both orders before the existing ledger settlement runs.
create or replace function private.validate_p2p_auto_match(p_event jsonb)
returns uuid language sql security definer set search_path = '' as $function$
  select b.id
  from public.p2p_orders s
  join public.p2p_orders b on b.escrow_chain_order_id=(p_event->>'counterOrderId')::numeric
  where s.escrow_chain_order_id=(p_event->>'orderId')::numeric
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

create or replace function public.finalize_p2p_escrow_auto_match(p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
  if coalesce(auth.jwt() ->> 'role',current_setting('request.jwt.claim.role',true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  v_fill_key:=lower(p_event->>'fillKey');
  v_tx_hash:=lower(p_event->>'txHash');
  qty:=(p_event->>'quantity')::numeric/1e18;
  released:=round((p_event->>'currencyReleased')::numeric/1e18,6);
  select * into old_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if old_fill.tx_hash<>v_tx_hash or old_fill.counter_chain_order_id is distinct from (p_event->>'counterOrderId')::numeric then raise exception 'fill key already used by another transaction'; end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;
  buy_uuid:=private.validate_p2p_auto_match(p_event);
  if buy_uuid is null then raise exception 'automatic chain fill does not match both database orders'; end if;
  select * into b from public.p2p_orders where id=buy_uuid;
  select * into old_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if old_fill.tx_hash<>v_tx_hash or old_fill.counter_chain_order_id is distinct from (p_event->>'counterOrderId')::numeric then raise exception 'fill key already used by another transaction'; end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;
  result:=public.finalize_p2p_escrow_fill(p_event || jsonb_build_object('counterOrderId','0','currencyReleased','0'));
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
    values(b.user_id,'p2p_order_release',released,b.asset_id,'escrow-fill:'||v_fill_key||':reserve-release',jsonb_build_object('order_id',b.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade'));
  update public.p2p_orders set remaining_quantity=remaining_quantity-qty,escrow_locked_currency=escrow_locked_currency-released,
    status=case when remaining_quantity-qty=0 then 'filled' else 'partially_filled' end,updated_at=now() where id=b.id;
  update public.p2p_escrow_fills f set counter_chain_order_id=(p_event->>'counterOrderId')::numeric,counter_order_id=b.id where f.fill_key=v_fill_key and f.tx_hash=v_tx_hash;
  return result || jsonb_build_object('buy_order_id',b.id,'automatic',true);
end;
$function$;

create or replace function public.finalize_p2p_escrow_cancel(p_user_id uuid,p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  o public.p2p_orders;
  chain_id numeric(78,0);
  refund_amount numeric;
begin
  if coalesce(auth.jwt() ->> 'role',current_setting('request.jwt.claim.role',true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  chain_id:=(p_event->>'orderId')::numeric;
  select * into o from public.p2p_orders where escrow_chain_order_id=chain_id for update;
  if not found or o.user_id<>p_user_id or o.escrow_mode<>'escrow' then raise exception 'escrow order not found'; end if;
  if o.status='cancelled' then update public.p2p_orders set escrow_locked_currency=0 where id=o.id; return jsonb_build_object('status','cancelled','idempotent',true); end if;
  if o.status='filled' and coalesce((p_event->>'refundedAmount')::numeric,0)=0 then update public.p2p_orders set escrow_locked_currency=0 where id=o.id; return jsonb_build_object('status','filled','idempotent',true); end if;
  if o.status not in ('open','partially_filled') then raise exception 'order is no longer cancellable'; end if;
  if o.side='buy' then
    refund_amount:=round((p_event->>'refundedAmount')::numeric/1e18,6);
    if refund_amount<>o.escrow_locked_currency then raise exception 'cancel refund does not match locked JC'; end if;
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(o.user_id,'p2p_order_release',refund_amount,o.asset_id,'escrow-cancel:'||chain_id::text,jsonb_build_object('order_id',o.id,'chain_order_id',chain_id,'tx_hash',p_event->>'txHash','reason','unfilled buy-order escrow refunded'));
  end if;
  update public.p2p_orders set status='cancelled',remaining_quantity=0,escrow_locked_currency=0,updated_at=now() where id=o.id;
  return jsonb_build_object('status','cancelled','refunded_jc',coalesce(refund_amount,0));
end;
$function$;

revoke all on function private.validate_p2p_auto_match(jsonb) from public,anon,authenticated;
grant execute on function private.validate_p2p_auto_match(jsonb) to service_role;
revoke all on function public.confirm_p2p_escrow_order(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.confirm_p2p_escrow_order(uuid,jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_auto_match(jsonb) from public,anon,authenticated;
grant execute on function public.finalize_p2p_escrow_auto_match(jsonb) to service_role;
revoke all on function public.finalize_p2p_escrow_cancel(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_p2p_escrow_cancel(uuid,jsonb) to service_role;
commit;

select has_function_privilege('authenticated','public.finalize_p2p_escrow_auto_match(jsonb)','EXECUTE') as authenticated_can_finalize;
select has_function_privilege('service_role','public.finalize_p2p_escrow_auto_match(jsonb)','EXECUTE') as service_role_can_finalize;
select column_name from information_schema.columns where table_schema='public' and table_name='p2p_escrow_fills' and column_name in ('counter_chain_order_id','counter_order_id');
