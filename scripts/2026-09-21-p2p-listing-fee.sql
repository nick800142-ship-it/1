-- 2026-09-21 二級市場手續費改制：掛賣單一次性手續費 + 每筆成交只收 1%
--
-- 問題：舊制每筆成交手續費 = gross*1% + 1 JC。一張賣單被多位買家分批買走時，
-- 「+1 JC」會被重複收取（例如 100 JC 賣單被兩位買家買走 → 1.5 + 1.5 = 3 JC，
-- 但實際應只收 2 JC）。
--
-- 新制（使用者決定）：
--   1) 賣家「掛賣單」時一次性收取固定 1 JC 手續費（直接進 Safe 金庫）；不論之後
--      被幾位買家分批買走都只收這一次；取消掛單不退還。
--   2) 每筆成交只收成交額的 1%（移除「+1 JC」固定項）。
-- 掛賣單前的鏈上錢包 JC 門檻（需 ≥ 1 JC）由前端負責擋下並提示；此處 DB 亦做
-- 站內帳本 ≥ 1 JC 的二次防護。1 JC 實際上鏈（賣方→ADMIN→Safe 兩跳）由 relayer
-- 的 list-fee action 處理，站內帳本此處先記 -1 JC 的 p2p_listing_fee 與 platform
-- 手續費列（source_type 沿用 p2p_fee、metadata.kind='listing'）。

-- ============================================================================
-- create_p2p_order：賣單掛單時收取 1 JC 一次性手續費
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_p2p_order(asset_key text, order_side text, order_price numeric, order_quantity numeric, request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.private_placements; r public.p2p_orders; maker public.p2p_orders;
  fixed_price numeric; owned numeric; reserved numeric; jc_bal numeric;
  is_ae boolean; px numeric; gross numeric;
  fill_qty numeric; matched_qty numeric:=0; match_count integer:=0;
  listing_fee numeric := 1; lf public.jc_ledger;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode='42501'; end if;
  if request_key is null or length(trim(request_key))<8 then raise exception 'invalid request key'; end if;
  if order_side not in ('buy','sell') then raise exception 'invalid side'; end if;
  if order_quantity is null or order_quantity<=0 or order_quantity>1000000 then raise exception 'invalid quantity'; end if;
  update public.private_placements set is_active=false,market_started_at=ends_at,updated_at=now() where id=asset_key and market_started_at is null and ends_at<=now() and not is_delisted;
  select * into a from public.private_placements where id=asset_key and not is_delisted and market_started_at is not null;
  if not found then raise exception 'secondary market unavailable'; end if;
  select jc_price into px from public.platform_config limit 1;
  if px is null or px<=0 then raise exception 'jc price unavailable'; end if;
  is_ae := coalesce(a.is_ae_token, true);
  -- RWA 份額必須整數；AE 允許小數（最多 6 位）。
  if is_ae then
    if round(order_quantity,6)<>order_quantity then raise exception 'invalid quantity'; end if;
  else
    if order_quantity<>trunc(order_quantity) then raise exception 'invalid quantity'; end if;
  end if;
  fixed_price := case when is_ae then round(order_price,6) else round(a.price,6) end;
  if fixed_price is null or fixed_price<=0 then raise exception 'invalid price'; end if;
  gross := round(fixed_price*order_quantity,6);
  if gross<2 then raise exception 'minimum trade 2 jc'; end if;
  if exists(select 1 from public.p2p_orders o where o.user_id=auth.uid() and o.asset_id=asset_key and o.side<>order_side and o.status in ('open','partially_filled')) then raise exception 'opposite side order exists'; end if;
  if order_side='sell' then
    select coalesce(h.quantity,0) into owned from public.holdings h where h.user_id=auth.uid() and h.asset_id=asset_key;
    owned := coalesce(owned,0);
    select coalesce(sum(o.remaining_quantity),0) into reserved from public.p2p_orders o where o.user_id=auth.uid() and o.asset_id=asset_key and o.side='sell' and o.status in ('open','partially_filled');
    if owned-reserved<order_quantity then raise exception 'insufficient shares'; end if;
    -- 掛賣單一次性手續費：站內帳本需有 ≥ 1 JC（鏈上錢包門檻由前端擋下）。
    select coalesce(sum(l.amount) filter (where l.entry_type<>'commission_pending'),0) into jc_bal from public.jc_ledger l where l.user_id=auth.uid();
    if jc_bal<listing_fee then raise exception 'insufficient listing fee'; end if;
  else
    select coalesce(sum(l.amount) filter (where l.entry_type<>'commission_pending'),0) into jc_bal from public.jc_ledger l where l.user_id=auth.uid();
    if jc_bal<gross then raise exception 'buyer insufficient balance'; end if;
  end if;
  insert into public.p2p_orders(user_id,asset_id,side,price,original_quantity,remaining_quantity)
  values(auth.uid(),asset_key,order_side,fixed_price,order_quantity,order_quantity) returning * into r;
  -- 賣單：立即收取一次性掛單手續費 1 JC（不論之後被幾位買家分批買走都只收一次；
  -- 取消掛單不退還）。站內帳本記 -1 JC，並寫平台手續費列（metadata.kind='listing'）。
  -- 1 JC 實際進 Safe 金庫的鏈上兩跳由 relayer 的 list-fee action 依此 idempotency_key 完成。
  if order_side='sell' then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(auth.uid(),'p2p_listing_fee',-listing_fee,asset_key,request_key||':listfee',
        jsonb_build_object('order_id',r.id,'kind','listing')) returning * into lf;
    insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
      values('p2p_fee',lf.id,auth.uid(),asset_key,listing_fee,
        jsonb_build_object('order_id',r.id,'kind','listing','currency','jc'));
  end if;
  loop
    exit when r.remaining_quantity<=0 or match_count>=1000;
    select o.* into maker from public.p2p_orders o
    where o.asset_id=asset_key and o.user_id<>r.user_id and o.side<>r.side and o.status in ('open','partially_filled')
     and ((r.side='buy' and o.price<=r.price) or (r.side='sell' and o.price>=r.price))
     and round(o.price*least(o.remaining_quantity,r.remaining_quantity),6)>=2
     and (o.side<>'sell' or
          coalesce((select h.quantity from public.holdings h where h.user_id=o.user_id and h.asset_id=o.asset_id),0)>=least(o.remaining_quantity,r.remaining_quantity))
     and (o.side<>'buy' or coalesce((select sum(l.amount) filter (where l.entry_type<>'commission_pending') from public.jc_ledger l where l.user_id=o.user_id),0)>=round(o.price*least(o.remaining_quantity,r.remaining_quantity),6))
    order by case when r.side='buy' then o.price end asc,case when r.side='sell' then o.price end desc,o.created_at asc,o.id asc
    limit 1 for update skip locked;
    exit when not found;
    fill_qty := least(maker.remaining_quantity,r.remaining_quantity);
    perform private.settle_p2p_match(maker.id,r.id,fill_qty,request_key||':match:'||match_count::text);
    matched_qty := matched_qty+fill_qty; match_count := match_count+1;
    select * into r from public.p2p_orders where id=r.id;
  end loop;
  return jsonb_build_object('id',r.id,'status',r.status,'matched_quantity',matched_qty,'remaining_quantity',r.remaining_quantity,'match_count',match_count);
end $function$;

-- ============================================================================
-- fill_p2p_order：每筆成交手續費改為只收 1%（移除 +1 JC）
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fill_p2p_order(order_key uuid, fill_quantity numeric, request_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  o public.p2p_orders; buyer uuid; seller uuid;
  gross numeric; px numeric; platform_fee numeric; seller_net numeric;
  buyer_jc numeric; seller_owned numeric; is_ae boolean;
  buyer_ledger public.jc_ledger; seller_ledger public.jc_ledger;
  prev_traded_price numeric; new_change numeric;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode='42501'; end if;
  if request_key is null or length(trim(request_key))<8 then raise exception 'invalid request key'; end if;
  if fill_quantity is null or fill_quantity<=0 or fill_quantity>1000000 then raise exception 'invalid quantity'; end if;
  select * into o from public.p2p_orders where id=order_key for update;
  if not found or o.status not in('open','partially_filled') then raise exception 'order unavailable'; end if;
  if o.user_id=auth.uid() then raise exception 'cannot fill own order'; end if;
  select coalesce(is_ae_token,true) into is_ae from public.private_placements where id=o.asset_id;
  -- RWA 份額必須整數；AE 允許小數（最多 6 位）。
  if is_ae then
    if round(fill_quantity,6)<>fill_quantity then raise exception 'invalid quantity'; end if;
  else
    if fill_quantity<>trunc(fill_quantity) then raise exception 'invalid quantity'; end if;
  end if;
  if fill_quantity>o.remaining_quantity then raise exception 'insufficient order quantity'; end if;
  if o.side='sell' then buyer:=auth.uid(); seller:=o.user_id; else buyer:=o.user_id; seller:=auth.uid(); end if;
  gross := round(o.price*fill_quantity,6);
  if gross<2 then raise exception 'minimum trade 2 jc'; end if;
  select jc_price into px from public.platform_config limit 1;
  if px is null or px<=0 then raise exception 'jc price unavailable'; end if;
  platform_fee := round(gross*0.01,6);
  seller_net := round(gross-platform_fee,6);
  if seller_net<=0 then raise exception 'trade too small'; end if;
  perform 1 from public.profiles where id in(buyer,seller) order by id for update;
  select coalesce(quantity,0) into seller_owned from public.holdings where user_id=seller and asset_id=o.asset_id for update;
  if seller_owned<fill_quantity then raise exception 'seller insufficient holdings'; end if;
  select coalesce(sum(amount) filter (where entry_type<>'commission_pending'),0) into buyer_jc from public.jc_ledger where user_id=buyer;
  if buyer_jc<gross then raise exception 'buyer insufficient balance'; end if;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(buyer,'p2p_buy',-gross,o.asset_id,fill_quantity,request_key||':buyer',
      jsonb_build_object('gross',gross,'order_id',o.id,'counterparty_id',seller)) returning * into buyer_ledger;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(seller,'p2p_sell',seller_net,o.asset_id,-fill_quantity,request_key||':seller',
      jsonb_build_object('gross',gross,'fee',platform_fee,'order_id',o.id,'counterparty_id',buyer)) returning * into seller_ledger;
  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(buyer,o.asset_id,fill_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
  update public.holdings set quantity=quantity-fill_quantity,updated_at=now() where user_id=seller and asset_id=o.asset_id;
  update public.p2p_orders set remaining_quantity=remaining_quantity-fill_quantity,
    status=case when remaining_quantity-fill_quantity=0 then 'filled' else 'partially_filled' end,updated_at=now() where id=o.id;
  insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
    values('p2p_fee',seller_ledger.id,seller,o.asset_id,platform_fee,jsonb_build_object('order_id',o.id,'gross',gross,'currency','jc'));
  perform private.post_referral_commissions(seller,o.asset_id,'secondary',gross,seller_ledger.id,request_key||':commission');
  select price into prev_traded_price from public.market_price_snapshots where asset_id=o.asset_id order by recorded_at desc limit 1;
  insert into public.market_price_snapshots(asset_id,price,recorded_by) values(o.asset_id,o.price,auth.uid());
  new_change := case when prev_traded_price is null or prev_traded_price=0 then 0 else round((o.price-prev_traded_price)/prev_traded_price*100,4) end;
  update public.private_placements set last_traded_price=o.price, change=new_change, updated_at=now() where id=o.asset_id;
  if auth.uid()=seller then return jsonb_build_object('role','seller','gross',gross,'platform_fee',platform_fee,'net',seller_net,'quantity',fill_quantity); end if;
  return jsonb_build_object('role','buyer','gross',gross,'total',gross,'quantity',fill_quantity);
end
$function$;

-- ============================================================================
-- private.settle_p2p_match：自動撮合的每筆成交手續費同樣改為只收 1%
-- ============================================================================
CREATE OR REPLACE FUNCTION private.settle_p2p_match(maker_order_key uuid, taker_order_key uuid, match_quantity numeric, match_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  maker public.p2p_orders; taker public.p2p_orders; buyer uuid; seller uuid;
  gross numeric; px numeric; platform_fee numeric; seller_net numeric;
  buyer_jc numeric; seller_owned numeric; is_ae boolean;
  buyer_ledger public.jc_ledger; seller_ledger public.jc_ledger;
  prev_traded_price numeric; new_change numeric;
begin
  if maker_order_key = taker_order_key then raise exception 'invalid self match'; end if;
  perform 1 from public.p2p_orders where id in (maker_order_key,taker_order_key) order by id for update;
  select * into maker from public.p2p_orders where id=maker_order_key;
  select * into taker from public.p2p_orders where id=taker_order_key;
  if maker.id is null or taker.id is null
     or maker.status not in ('open','partially_filled') or taker.status not in ('open','partially_filled')
     or maker.asset_id<>taker.asset_id or maker.side=taker.side or maker.user_id=taker.user_id then raise exception 'orders unavailable'; end if;
  select coalesce(is_ae_token,true) into is_ae from public.private_placements where id=maker.asset_id;
  if match_quantity is null or match_quantity<=0
     or match_quantity>maker.remaining_quantity or match_quantity>taker.remaining_quantity then raise exception 'invalid match quantity'; end if;
  -- RWA 份額必須整數；AE 允許小數（最多 6 位）。
  if is_ae then
    if round(match_quantity,6)<>match_quantity then raise exception 'invalid match quantity'; end if;
  else
    if match_quantity<>trunc(match_quantity) then raise exception 'invalid match quantity'; end if;
  end if;
  if taker.side='buy' and taker.price<maker.price then raise exception 'prices do not cross'; end if;
  if taker.side='sell' and taker.price>maker.price then raise exception 'prices do not cross'; end if;
  if maker.side='sell' then buyer:=taker.user_id; seller:=maker.user_id; else buyer:=maker.user_id; seller:=taker.user_id; end if;
  gross := round(maker.price*match_quantity,6);
  if gross<2 then raise exception 'minimum trade 2 jc'; end if;
  select jc_price into px from public.platform_config limit 1;
  if px is null or px<=0 then raise exception 'jc price unavailable'; end if;
  platform_fee := round(gross*0.01,6);
  seller_net := round(gross-platform_fee,6);
  if seller_net<=0 then raise exception 'trade too small'; end if;
  perform 1 from public.profiles where id in (buyer,seller) order by id for update;
  select coalesce(quantity,0) into seller_owned from public.holdings where user_id=seller and asset_id=maker.asset_id for update;
  if seller_owned<match_quantity then raise exception 'seller insufficient holdings'; end if;
  select coalesce(sum(amount) filter (where entry_type<>'commission_pending'),0) into buyer_jc from public.jc_ledger where user_id=buyer;
  if buyer_jc<gross then raise exception 'buyer insufficient balance'; end if;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(buyer,'p2p_buy',-gross,maker.asset_id,match_quantity,match_key||':buyer',
      jsonb_build_object('gross',gross,'maker_order_id',maker.id,'taker_order_id',taker.id,'counterparty_id',seller,'automatic_match',true)) returning * into buyer_ledger;
  insert into public.jc_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
    values(seller,'p2p_sell',seller_net,maker.asset_id,-match_quantity,match_key||':seller',
      jsonb_build_object('gross',gross,'fee',platform_fee,'maker_order_id',maker.id,'taker_order_id',taker.id,'counterparty_id',buyer,'automatic_match',true)) returning * into seller_ledger;
  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(buyer,maker.asset_id,match_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
  update public.holdings set quantity=quantity-match_quantity,updated_at=now() where user_id=seller and asset_id=maker.asset_id;
  update public.p2p_orders set remaining_quantity=remaining_quantity-match_quantity,
    status=case when remaining_quantity-match_quantity=0 then 'filled' else 'partially_filled' end,updated_at=now() where id in (maker.id,taker.id);
  insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,metadata)
    values('p2p_fee',seller_ledger.id,seller,maker.asset_id,platform_fee,jsonb_build_object('maker_order_id',maker.id,'taker_order_id',taker.id,'gross',gross,'currency','jc'));
  perform private.post_referral_commissions(seller,maker.asset_id,'secondary',gross,seller_ledger.id,match_key||':commission');
  select price into prev_traded_price from public.market_price_snapshots where asset_id=maker.asset_id order by recorded_at desc limit 1;
  insert into public.market_price_snapshots(asset_id,price,recorded_by) values(maker.asset_id,maker.price,buyer);
  new_change := case when prev_traded_price is null or prev_traded_price=0 then 0 else round((maker.price-prev_traded_price)/prev_traded_price*100,4) end;
  update public.private_placements set last_traded_price=maker.price, change=new_change, updated_at=now() where id=maker.asset_id;
  return jsonb_build_object('quantity',match_quantity,'price',maker.price,'gross',gross,'buyer',buyer,'seller',seller);
end $function$;
