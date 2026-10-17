-- 二級市場費率可調整（新託管合約），舊託管合約掛單維持原費率（1% / 1 JC）不受影響。
-- p2p_orders.fee_bps / listing_fee 為 null 代表舊合約掛單，一律視為 100 bps / 1 JC。

alter table public.platform_config
  add column if not exists p2p_fee_bps integer not null default 100,
  add column if not exists p2p_listing_fee numeric not null default 1,
  add column if not exists p2p_fees_updated_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'platform_config_p2p_fee_bps_check') then
    alter table public.platform_config add constraint platform_config_p2p_fee_bps_check check (p2p_fee_bps between 0 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'platform_config_p2p_listing_fee_check') then
    alter table public.platform_config add constraint platform_config_p2p_listing_fee_check
      check (p2p_listing_fee >= 0 and p2p_listing_fee <= 10 and p2p_listing_fee = round(p2p_listing_fee, 6));
  end if;
end $$;

alter table public.p2p_orders
  add column if not exists fee_bps integer,
  add column if not exists listing_fee numeric;

-- 掛賣單預留的掛單費改讀目前設定值（取代寫死的 1 JC）。
do $$
declare def text;
begin
  select pg_get_functiondef('public.reserve_p2p_escrow_order(text,text,numeric,numeric,uuid,text)'::regprocedure) into def;
  if position('then 1 else gross end' in def) > 0 then
    def := replace(def, 'reserve_jc := case when p_side=''sell'' then 1 else gross end;',
      'reserve_jc := case when p_side=''sell'' then coalesce((select c.p2p_listing_fee from public.platform_config c limit 1),1) else gross end;');
    if position('then 1 else gross end' in def) > 0 then raise exception 'reserve patch failed'; end if;
    execute def;
  end if;
end $$;

-- 確認掛單：掛單費與成交費率一律以鏈上事件為準，並寫入掛單快照。
create or replace function public.confirm_p2p_escrow_order(p_user_id uuid, p_event jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  r public.p2p_escrow_order_reservations; existing public.p2p_orders; order_uuid uuid; chain_id numeric(78,0);
  is_sell boolean; order_price numeric; order_quantity numeric; listing_fee numeric; order_fee_bps integer;
  escrow_contract text; fee_row public.jc_ledger;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  select * into r from public.p2p_escrow_order_reservations where client_order_id=lower(p_event->>'clientOrderId') for update;
  if not found or r.user_id<>p_user_id then raise exception 'order reservation not found'; end if;
  chain_id := (p_event->>'orderId')::numeric;
  escrow_contract := private.escrow_event_contract(p_event);
  if escrow_contract !~ '^0x[0-9a-f]{40}$' then raise exception 'invalid escrow contract address'; end if;
  is_sell := (p_event->>'isSell')::boolean;
  order_price := round((p_event->>'price')::numeric/1e18,6);
  order_quantity := (p_event->>'quantity')::numeric/1e18;
  listing_fee := round((p_event->>'listingFee')::numeric/1e18,6);
  order_fee_bps := coalesce(nullif(p_event->>'feeBps','')::integer, 100);
  if r.status='released' then raise exception 'order reservation has been released'; end if;
  if (case when is_sell then 'sell' else 'buy' end)<>r.side or order_price<>r.price or order_quantity<>r.quantity then
    raise exception 'onchain order does not match reservation';
  end if;
  if (is_sell and (listing_fee<0 or listing_fee>10)) or (not is_sell and listing_fee<>0) then raise exception 'invalid listing fee'; end if;
  if order_fee_bps<0 or order_fee_bps>500 then raise exception 'invalid fee rate'; end if;
  select * into existing from public.p2p_orders where escrow_chain_order_id=chain_id and escrow_contract_address=escrow_contract;
  if found then
    if existing.escrow_request_key<>r.request_key::text or existing.user_id<>p_user_id then
      raise exception 'chain order id already registered for this escrow contract';
    end if;
    return jsonb_build_object('id',existing.id,'status',existing.status,'idempotent',true);
  end if;
  if r.status='confirmed' then raise exception 'reservation already confirmed without an order'; end if;
  insert into public.p2p_orders(user_id,asset_id,side,price,original_quantity,remaining_quantity,status,escrow_mode,escrow_request_key,
    escrow_chain_order_id,escrow_contract_address,escrow_create_tx_hash,escrow_token_address,escrow_currency_address,escrow_locked_currency,fee_bps,listing_fee)
  values (p_user_id,r.asset_id,r.side,r.price,r.quantity,r.quantity,'open','escrow',r.request_key::text,chain_id,escrow_contract,p_event->>'txHash',
    lower(p_event->>'assetToken'),lower(p_event->>'currencyToken'),case when is_sell then 0 else round(r.price * r.quantity, 6) end,
    order_fee_bps,listing_fee)
  returning * into existing;
  order_uuid := existing.id;
  update public.p2p_escrow_order_reservations set status='confirmed',updated_at=now() where request_key=r.request_key;
  if is_sell then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(p_user_id,'p2p_order_release',r.reserved_jc,r.asset_id,'p2p-reserve-release:'||r.request_key::text,
        jsonb_build_object('request_key',r.request_key,'reason','listing fee finalized'))
      on conflict (idempotency_key) do nothing;
    if listing_fee > 0 then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
        values(p_user_id,'p2p_listing_fee',-listing_fee,r.asset_id,'escrow-listing-fee:'||escrow_contract||':'||chain_id::text,
          jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'escrow_contract',escrow_contract,'kind','listing','tx_hash',p_event->>'txHash'))
        returning * into fee_row;
      insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
        values('p2p_fee',fee_row.id,p_user_id,r.asset_id,listing_fee,
          jsonb_build_object('order_id',order_uuid,'chain_order_id',chain_id,'escrow_contract',escrow_contract,'kind','listing','currency','jc','tx_hash',p_event->>'txHash'));
    end if;
  end if;
  return jsonb_build_object('id',order_uuid,'status','open','chain_order_id',chain_id::text);
end $function$;

-- 成交手續費改依「該掛單建立時的費率快照」驗證（舊單 null → 100 bps）。
do $$
declare def text;
begin
  select pg_get_functiondef('public.finalize_p2p_escrow_fill(jsonb)'::regprocedure) into def;
  if position('round(v_gross*0.01,6)<>v_fee' in def) > 0 then
    def := replace(def, E'\n    or round(v_gross*0.01,6)<>v_fee then raise exception', ' then raise exception');
    def := replace(def,
      E'or v_currency_released<0 then raise exception ''chain trade does not match database order''; end if;',
      E'or v_currency_released<0 then raise exception ''chain trade does not match database order''; end if;\n  if round(v_gross*coalesce(o.fee_bps,100)/10000.0,6)<>v_fee then raise exception ''invalid escrow fill fee''; end if;');
    if position('round(v_gross*0.01,6)' in def) > 0 or position('invalid escrow fill fee' in def) = 0 then
      raise exception 'finalize_p2p_escrow_fill patch did not apply cleanly';
    end if;
    execute def;
  end if;
end $$;

-- 訂單簿：p_escrow_contract_address 為 null 時回傳所有託管合約的掛單（新舊並存），並帶出費率快照。
drop function if exists public.get_p2p_order_book(text, text);
create function public.get_p2p_order_book(asset_key text default null, p_escrow_contract_address text default null)
returns jsonb language sql security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',o.id,'asset_id',o.asset_id,'side',o.side,'price',o.price,
      'original_quantity',o.original_quantity,'remaining_quantity',o.remaining_quantity,
      'status',o.status,'created_at',o.created_at,'is_mine',o.user_id=auth.uid(),
      'escrow_chain_order_id',o.escrow_chain_order_id,
      'escrow_contract_address',o.escrow_contract_address,
      'fee_bps',coalesce(o.fee_bps,100)
    ) order by case when o.side='sell' then o.price end asc,
               case when o.side='buy' then o.price end desc,o.created_at
  ),'[]')
  from public.p2p_orders o
  where auth.uid() is not null
    and o.status in ('open','partially_filled')
    and o.escrow_mode='escrow'
    and (p_escrow_contract_address is null or lower(o.escrow_contract_address)=lower(p_escrow_contract_address))
    and (asset_key is null or o.asset_id=asset_key)
$function$;
grant execute on function public.get_p2p_order_book(text,text) to authenticated;

drop function if exists public.get_my_p2p_orders(text);
create function public.get_my_p2p_orders(p_escrow_contract_address text default null)
returns jsonb language sql security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'asset_id',o.asset_id,'side',o.side,'price',o.price,
    'original_quantity',o.original_quantity,'remaining_quantity',o.remaining_quantity,
    'status',o.status,'created_at',o.created_at,'updated_at',o.updated_at,
    'escrow_chain_order_id',o.escrow_chain_order_id,'escrow_mode',o.escrow_mode,
    'escrow_create_tx_hash',o.escrow_create_tx_hash,
    'escrow_contract_address',o.escrow_contract_address,
    'fee_bps',coalesce(o.fee_bps,100),
    'listing_fee',coalesce(o.listing_fee,case when o.side='sell' then 1 else 0 end)
  ) order by o.created_at desc),'[]')
  from public.p2p_orders o
  where o.user_id=auth.uid()
    and (o.escrow_mode is distinct from 'escrow'
      or p_escrow_contract_address is null
      or lower(o.escrow_contract_address)=lower(p_escrow_contract_address))
$function$;
grant execute on function public.get_my_p2p_orders(text) to authenticated;

-- 後台設定費率只能由 relayer（service role）在鏈上 setFees 成功後寫入。
create or replace function public.service_set_p2p_fees(p_fee_bps integer, p_listing_fee numeric, p_admin_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  update public.platform_config
    set p2p_fee_bps=p_fee_bps, p2p_listing_fee=round(p_listing_fee,6), p2p_fees_updated_at=now(), updated_at=now(), updated_by=p_admin_id;
  return jsonb_build_object('fee_bps',p_fee_bps,'listing_fee',round(p_listing_fee,6));
end $function$;
revoke all on function public.service_set_p2p_fees(integer,numeric,uuid) from public, anon, authenticated;
grant execute on function public.service_set_p2p_fees(integer,numeric,uuid) to service_role;
