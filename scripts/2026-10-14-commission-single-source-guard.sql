-- 分潤「單一來源 + 資料庫層強制」：所有分潤費率只能來自後台設定（commission_settings / commission_user_overrides）。
-- 1) 移除寫死 3% / 0.2% 的舊觸發器（繞過後台設定的路徑）
-- 2) 新增唯一費率解析函式 private.resolve_commission_rate
-- 3) post_referral_commissions 改為只呼叫該函式
-- 4) commission_logs 寫入前由守門觸發器重新計算，費率/金額/受益人不符一律拒絕
-- 5) 清除後台改了但不會生效的設定陷阱（L2會員 / 代理 兩列分裂、舊 4 參數覆蓋 RPC）
begin;

-- 1) 舊的寫死費率觸發器
drop trigger if exists rwmt888888_special_commission on public.jc_ledger;
drop function if exists private.apply_rwmt888888_commission();

-- 2) 唯一費率解析函式
create or replace function private.resolve_commission_rate(p_kind text, p_slot text, p_beneficiary uuid, p_asset_mode text)
returns numeric
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  ov numeric; r numeric; lvl int := 0; walker uuid; settings_role text;
begin
  if p_kind not in ('private','secondary') or p_slot not in ('self','l1','l2') or p_asset_mode not in ('ae_coin','rwa') then
    raise exception 'resolve_commission_rate: invalid arguments (%, %, %)', p_kind, p_slot, p_asset_mode;
  end if;
  -- 二級市場：自己買賣沒有回饋（規則固定）
  if p_kind='secondary' and p_slot='self' then return 0; end if;

  select case p_kind||':'||p_slot
           when 'private:self' then o.self_private_rate
           when 'private:l1' then o.l1_private_rate
           when 'private:l2' then o.l2_private_rate
           when 'secondary:l1' then o.l1_secondary_rate
           when 'secondary:l2' then o.l2_secondary_rate
         end
    into ov
    from public.commission_user_overrides o
   where o.user_id=p_beneficiary and o.asset_mode=p_asset_mode;
  if ov is not null then return ov; end if;

  if p_kind='private' and p_slot in ('self','l1') then
    walker := (select coalesce(p.referrer_id,p.parent_id) from public.profiles p where p.id=p_beneficiary);
    while walker is not null and lvl<10 loop
      lvl := lvl+1;
      walker := (select coalesce(p.referrer_id,p.parent_id) from public.profiles p where p.id=walker);
    end loop;
  end if;

  settings_role := case
    when p_kind='private' and p_slot='self' then '總代理直屬'
    when p_kind='private' and p_slot='l1' and lvl=0 then '總代理直屬'
    when p_slot='l1' then '總代理'
    else '代理'
  end;

  if p_kind='private' then
    select s.private_rate into r from public.commission_settings s where s.agency_role=settings_role and s.asset_mode=p_asset_mode;
  else
    select s.secondary_rate into r from public.commission_settings s where s.agency_role=settings_role and s.asset_mode=p_asset_mode;
  end if;
  return coalesce(r,0);
end
$function$;

revoke all on function private.resolve_commission_rate(text,text,uuid,text) from public, anon, authenticated;

-- 5) 設定陷阱：函式原本讀 'L2會員'，後台卻編輯 '代理'。統一只認 '代理'。
delete from public.commission_settings where agency_role='L2會員';
drop function if exists public.admin_update_user_commission(uuid,numeric,numeric,text);

alter table public.commission_user_overrides
  add constraint commission_user_overrides_self_private_rate_range check (self_private_rate is null or (self_private_rate>=0 and self_private_rate<=1)),
  add constraint commission_user_overrides_l1_private_rate_range check (l1_private_rate is null or (l1_private_rate>=0 and l1_private_rate<=1)),
  add constraint commission_user_overrides_l2_private_rate_range check (l2_private_rate is null or (l2_private_rate>=0 and l2_private_rate<=1)),
  add constraint commission_user_overrides_self_secondary_rate_range check (self_secondary_rate is null or (self_secondary_rate>=0 and self_secondary_rate<=1)),
  add constraint commission_user_overrides_l1_secondary_rate_range check (l1_secondary_rate is null or (l1_secondary_rate>=0 and l1_secondary_rate<=1)),
  add constraint commission_user_overrides_l2_secondary_rate_range check (l2_secondary_rate is null or (l2_secondary_rate>=0 and l2_secondary_rate<=1));

-- 3) 分潤主函式：費率只來自 resolve_commission_rate
create or replace function private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  buyer public.profiles; beneficiary public.profiles; src_entry text; src_created timestamptz; month_start date;
  v_asset_mode text; v_parent_id uuid; depth int; rate numeric; amount_value numeric; ledger_id uuid; self_rate numeric := 0; bonus_type text; self_unlocked boolean;
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
      self_rate:=private.resolve_commission_rate('private','self',buyer.id,v_asset_mode); amount_value:=round(gross*self_rate,6);
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

    bonus_type:=case when depth=1 then 'l1' else 'l2' end;
    rate:=private.resolve_commission_rate(transaction_kind,bonus_type,beneficiary.id,v_asset_mode);
    amount_value:=round(gross*rate,6);
    if amount_value>0 then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata) values(beneficiary.id,'commission_pending',amount_value,asset_key,request_key||'-l'||depth,jsonb_build_object('bonus_type',bonus_type,'commission_level','L'||depth,'rate',rate,'referral_depth',depth,'source_ledger_id',source_id,'asset_mode',v_asset_mode)) on conflict(idempotency_key) do nothing returning id into ledger_id;
      if ledger_id is not null then insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency) values(beneficiary.id,buyer_id,asset_key,transaction_kind,gross,rate,amount_value,ledger_id,bonus_type,beneficiary.id,beneficiary.id,buyer_id,source_id,rate,0,rate,month_start,'jc') on conflict(source_ledger_id,beneficiary_id) do nothing; end if;
    end if;
    v_parent_id:=coalesce(beneficiary.referrer_id,beneficiary.parent_id);
  end loop;
end;
$function$;

-- 4) 守門觸發器：任何路徑寫入 commission_logs，費率/金額/受益人必須等於後台設定重新計算的結果
create or replace function private.guard_commission_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_mode text; v_slot text; v_expected numeric; v_parent uuid; v_expected_beneficiary uuid;
begin
  if new.bonus_type not in ('self_rebate','l1','l2') then
    raise exception 'commission guard: bonus_type % 不允許寫入（只允許 self_rebate/l1/l2）', new.bonus_type;
  end if;
  select case when pp.is_ae_token then 'ae_coin' else 'rwa' end into v_mode from public.private_placements pp where pp.id=new.asset_id;
  v_mode := coalesce(v_mode,'ae_coin');
  v_slot := case new.bonus_type when 'self_rebate' then 'self' else new.bonus_type end;

  if new.bonus_type='self_rebate' then
    v_expected_beneficiary := new.source_user_id;
  else
    v_parent := (select coalesce(p.referrer_id,p.parent_id) from public.profiles p where p.id=new.source_user_id);
    if new.bonus_type='l1' then
      v_expected_beneficiary := v_parent;
    else
      v_expected_beneficiary := (select coalesce(p.referrer_id,p.parent_id) from public.profiles p where p.id=v_parent);
    end if;
  end if;
  if new.beneficiary_id is distinct from v_expected_beneficiary then
    raise exception 'commission guard: 受益人與推薦鏈不符（bonus_type=%）', new.bonus_type;
  end if;

  v_expected := private.resolve_commission_rate(new.transaction_type, v_slot, new.beneficiary_id, v_mode);
  if abs(new.commission_rate - v_expected) > 0.000001 then
    raise exception 'commission guard: 費率 % 與後台設定 % 不符', new.commission_rate, v_expected;
  end if;
  if abs(new.commission_amount - round(new.transaction_amount * v_expected, 6)) > 0.000002 then
    raise exception 'commission guard: 金額 % 與後台費率計算結果 % 不符', new.commission_amount, round(new.transaction_amount * v_expected, 6);
  end if;
  return new;
end
$function$;

drop trigger if exists commission_logs_guard on public.commission_logs;
create trigger commission_logs_guard before insert on public.commission_logs
  for each row execute function private.guard_commission_log();

-- 稽核：逐筆用「目前後台設定」重算 commission_logs，並找出應有卻缺漏的分潤
create or replace function public.admin_commission_rate_audit(p_since timestamptz default '2026-10-14 00:00:00+00')
returns table(kind text, source_ledger_id uuid, beneficiary_id uuid, bonus_type text, actual_rate numeric, expected_rate numeric, actual_amount numeric, expected_amount numeric, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  return query
  select 'rate_mismatch'::text, c.source_ledger_id, c.beneficiary_id, c.bonus_type, c.commission_rate, e.expected, c.commission_amount, round(c.transaction_amount*e.expected,6), c.created_at
  from public.commission_logs c
  left join public.private_placements pp on pp.id=c.asset_id
  cross join lateral (select private.resolve_commission_rate(c.transaction_type, case c.bonus_type when 'self_rebate' then 'self' else c.bonus_type end, c.beneficiary_id, case when coalesce(pp.is_ae_token,true) then 'ae_coin' else 'rwa' end) as expected) e
  where c.created_at>=p_since and c.bonus_type in ('self_rebate','l1','l2')
    and (abs(c.commission_rate-e.expected)>0.000001 or abs(c.commission_amount-round(c.transaction_amount*e.expected,6))>0.000002);

  return query
  select 'unexpected_bonus_type'::text, c.source_ledger_id, c.beneficiary_id, c.bonus_type, c.commission_rate, null::numeric, c.commission_amount, null::numeric, c.created_at
  from public.commission_logs c where c.created_at>=p_since and c.bonus_type not in ('self_rebate','l1','l2');

  return query
  with src as (
    select j.id sid, j.user_id uid, j.asset_id, j.created_at, abs(j.amount) gross,
           case when j.entry_type='private_purchase' then 'private' else 'secondary' end kind
      from public.jc_ledger j
     where j.created_at>=p_since
       and ((j.entry_type='private_purchase' and j.amount<0) or (j.entry_type in ('p2p_sell','secondary_sell') and j.amount>0))
  ), up as (
    select s.*, 'l1'::text slot, (select coalesce(p.referrer_id,p.parent_id) from public.profiles p where p.id=s.uid) ben from src s
    union all
    select s.*, 'l2'::text, (select coalesce(p2.referrer_id,p2.parent_id) from public.profiles p1 join public.profiles p2 on p2.id=coalesce(p1.referrer_id,p1.parent_id) where p1.id=s.uid) from src s
  )
  select 'missing_commission'::text, u.sid, u.ben, u.slot, 0::numeric, r.rate, 0::numeric, round(u.gross*r.rate,6), u.created_at
  from up u
  left join public.private_placements pp on pp.id=u.asset_id
  cross join lateral (select private.resolve_commission_rate(u.kind,u.slot,u.ben,case when coalesce(pp.is_ae_token,true) then 'ae_coin' else 'rwa' end) rate) r
  where u.ben is not null and r.rate>0 and round(u.gross*r.rate,6)>0
    and not exists (select 1 from public.commission_logs c where c.source_ledger_id=u.sid and c.beneficiary_id=u.ben);
end
$function$;

revoke all on function public.admin_commission_rate_audit(timestamptz) from public, anon;
grant execute on function public.admin_commission_rate_audit(timestamptz) to authenticated;

commit;
