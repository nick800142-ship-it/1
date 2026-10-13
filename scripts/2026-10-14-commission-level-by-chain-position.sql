-- 分潤費率層級改依「受益人在整條推薦鏈中的位置」決定，而非只看受益人有沒有上線。
-- 規則（對應後台 commission_settings）：
--   私募 L1 買入 → 上層 L0 拿「總代理直屬」(3%)
--   私募 L2 買入 → 上層 L1 拿「總代理」(2%)、再上層 L0 拿「L2會員」(1%)
--   二級 L1 賣出 → 上層 L0 拿「總代理」二級費率 (0.13%)
--   二級 L2 賣出 → 上層 L1 拿「總代理」二級費率 (0.13%)、L0 拿「L2會員」二級費率 (0.07%)
-- 個人覆蓋 (commission_user_overrides) 仍優先於後台設定。

create or replace function private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  buyer public.profiles; beneficiary public.profiles; src_entry text; src_created timestamptz; month_start date;
  v_asset_mode text; v_parent_id uuid; depth int; rate numeric; settings_role text; amount_value numeric; ledger_id uuid; self_rate numeric := 0; bonus_type text; self_unlocked boolean;
  ben_level int; walker uuid;
begin
  select entry_type,created_at into src_entry,src_created from public.jc_ledger where id=source_id;
  if transaction_kind='private' and src_entry is distinct from 'private_purchase' then return; end if;
  if transaction_kind='secondary' and src_entry not in ('secondary_sell','p2p_sell') then return; end if;
  if transaction_kind not in ('private','secondary') or gross is null or gross<=0 then return; end if;
  select * into buyer from public.profiles where id=buyer_id;
  if buyer.id is null then return; end if;
  select case when pp.is_ae_token then 'ae_coin' else 'rwa' end into v_asset_mode from public.private_placements pp where pp.id=asset_key;
  v_asset_mode:=coalesce(v_asset_mode,'ae_coin'); month_start:=date_trunc('month',coalesce(src_created,now()))::date;

  if transaction_kind='private' then
    self_unlocked := upper(regexp_replace(coalesce(buyer.special_promo_code, buyer.promo_code, ''), '[^A-Z0-9]', '', 'g'))='RWMT88888'
      or exists (select 1 from public.profiles l1 left join public.profiles l2 on l2.referrer_id=l1.id or l2.parent_id=l1.id join public.jc_ledger j on j.user_id in (l1.id,l2.id) where (l1.referrer_id=buyer.id or l1.parent_id=buyer.id) and j.entry_type='private_purchase' and j.amount<0);
    if self_unlocked then
      select o.self_private_rate into self_rate from public.commission_user_overrides o where o.user_id=buyer.id and o.asset_mode=v_asset_mode;
      if self_rate is null then
        select s.private_rate into self_rate from public.commission_settings s where s.agency_role='總代理直屬' and s.asset_mode=v_asset_mode;
      end if;
      self_rate:=coalesce(self_rate,0); amount_value:=round(gross*self_rate,6);
      if amount_value>0 then
        insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata) values(buyer.id,'commission_pending',amount_value,asset_key,request_key||'-self',jsonb_build_object('bonus_type','self_rebate','commission_level','L0','rate',self_rate,'source_ledger_id',source_id,'asset_mode',v_asset_mode)) on conflict(idempotency_key) do nothing returning id into ledger_id;
        if ledger_id is not null then insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency) values(buyer.id,buyer.id,asset_key,transaction_kind,gross,self_rate,amount_value,ledger_id,'self_rebate',buyer.id,buyer.id,buyer.id,source_id,self_rate,0,self_rate,month_start,'jc') on conflict(source_ledger_id,beneficiary_id) do nothing; end if;
      end if;
    end if;
  end if;

  v_parent_id:=coalesce(buyer.referrer_id,buyer.parent_id);
  for depth in 1..2 loop
    exit when v_parent_id is null;
    select * into beneficiary from public.profiles where id=v_parent_id;
    exit when beneficiary.id is null;

    ben_level:=0; walker:=coalesce(beneficiary.referrer_id,beneficiary.parent_id);
    while walker is not null and ben_level<10 loop
      ben_level:=ben_level+1;
      select coalesce(p.referrer_id,p.parent_id) into walker from public.profiles p where p.id=walker;
    end loop;

    if transaction_kind='private' then
      settings_role:=case when depth=1 and ben_level=0 then '總代理直屬' when depth=1 then '總代理' else 'L2會員' end;
    else
      settings_role:=case when depth=1 then '總代理' else 'L2會員' end;
    end if;

    rate:=null;
    if transaction_kind='private' then
      select case when depth=1 then o.l1_private_rate else o.l2_private_rate end into rate from public.commission_user_overrides o where o.user_id=beneficiary.id and o.asset_mode=v_asset_mode;
    else
      select case when depth=1 then o.l1_secondary_rate else o.l2_secondary_rate end into rate from public.commission_user_overrides o where o.user_id=beneficiary.id and o.asset_mode=v_asset_mode;
    end if;
    if rate is null then
      if transaction_kind='private' then select s.private_rate into rate from public.commission_settings s where s.agency_role=settings_role and s.asset_mode=v_asset_mode; else select s.secondary_rate into rate from public.commission_settings s where s.agency_role=settings_role and s.asset_mode=v_asset_mode; end if;
    end if;
    rate:=coalesce(rate,0);
    amount_value:=round(gross*rate,6); bonus_type:=case when depth=1 then 'l1' else 'l2' end;
    if amount_value>0 then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata) values(beneficiary.id,'commission_pending',amount_value,asset_key,request_key||'-l'||depth,jsonb_build_object('bonus_type',bonus_type,'commission_level','L'||depth,'rate',rate,'referral_depth',depth,'source_ledger_id',source_id,'asset_mode',v_asset_mode)) on conflict(idempotency_key) do nothing returning id into ledger_id;
      if ledger_id is not null then insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency) values(beneficiary.id,buyer_id,asset_key,transaction_kind,gross,rate,amount_value,ledger_id,bonus_type,beneficiary.id,beneficiary.id,buyer_id,source_id,rate,0,rate,month_start,'jc') on conflict(source_ledger_id,beneficiary_id) do nothing; end if;
    end if;
    v_parent_id:=coalesce(beneficiary.referrer_id,beneficiary.parent_id);
  end loop;
end;
$function$;
