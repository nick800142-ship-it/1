-- 主網新 Supabase 專案用：測試網資料庫的結構（表、函式、RLS、權限），不含任何資料。
-- 產生方式：pg_dump --schema-only --no-owner --schema=public --schema=private（2026-10-18）。
-- 執行順序見 scripts/mainnet/db/README.md。

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS private;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: agent_six_month_boost(uuid, date); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.agent_six_month_boost(agent_id uuid, month_start date) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare i integer; begin for i in 0..5 loop if private.new_effective_count(agent_id,(month_start-(i||' months')::interval)::date,false)<5 then return 0; end if; end loop; return .02; end $$;


--
-- Name: available_ae(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.available_ae(uid uuid) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(
           (select quantity from public.holdings
             where user_id = uid and asset_id = 'ae-token-daily'), 0)
       - coalesce(
           (select sum(ae_locked) from public.rwa_placement_escrows
             where user_id = uid and status = 'locked'), 0)
$$;


--
-- Name: block_secondary_orders_during_price_lock(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.block_secondary_orders_during_price_lock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ begin if new.entry_type in ('secondary_buy','secondary_sell') and exists(select 1 from public.private_placements p where p.id=new.asset_id and p.price_locked_until>now()) then raise exception 'price update cooldown'; end if; return new; end $$;


--
-- Name: current_ae_price(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.current_ae_price() RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(last_traded_price, price)
  from public.private_placements
  where id = 'ae-token-daily'
$$;


--
-- Name: encumbered_ae(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.encumbered_ae(uid uuid) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce((select sum(ae_locked) from public.rwa_placement_escrows
                    where user_id = uid and status = 'locked'), 0)
$$;


--
-- Name: ensure_genesis_l0_profile(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.ensure_genesis_l0_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  update public.profiles
  set agency_role = coalesce(nullif(agency_role, ''), 'user'),
      promo_code = coalesce(promo_code, private.generate_promo_code())
  where id = new.id and promo_code is null;
  return new;
end
$$;


--
-- Name: escrow_event_contract(jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.escrow_event_contract(p_event jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select lower(coalesce(
    nullif(p_event->>'escrowContract', ''),
    '0xbfb3456226ca1e46cf2bdb3b2d42619a2b7b8db0'
  ))
$$;


--
-- Name: generate_promo_code(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.generate_promo_code() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare code text; begin loop code:=upper(substr(md5(gen_random_uuid()::text),1,9)); exit when not exists(select 1 from public.profiles where upper(promo_code)=code); end loop; return code; end $$;


--
-- Name: guard_asset_market_phase(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.guard_asset_market_phase() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  started_at timestamptz;
  active boolean;
  remaining numeric;
  ending timestamptz;
  ae_token boolean;
  is_final_subscription_transition boolean;
begin
  if new.asset_id is null or new.entry_type not in ('private_purchase','secondary_buy','secondary_sell') then
    return new;
  end if;

  select market_started_at, is_active, available, ends_at, is_ae_token
  into started_at, active, remaining, ending, ae_token
  from public.private_placements
  where id = new.asset_id;

  if not found then
    raise exception 'asset unavailable';
  end if;

  is_final_subscription_transition :=
    new.entry_type = 'private_purchase'
    and remaining = 0
    and active = false
    and started_at = transaction_timestamp()
    and ending = transaction_timestamp();

  if new.entry_type = 'private_purchase'
     and not is_final_subscription_transition
     and ((started_at is not null and not ae_token) or not active or remaining <= 0 or ending <= clock_timestamp()) then
    raise exception 'placement ended';
  end if;

  if new.entry_type in ('secondary_buy','secondary_sell') and started_at is null then
    raise exception 'secondary market unavailable';
  end if;

  return new;
end;
$$;


--
-- Name: guard_commission_log(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.guard_commission_log() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: guard_jc_reservation_debit(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.guard_jc_reservation_debit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  locked_user uuid;
  ledger_balance numeric;
  held_balance numeric;
  current_request_key text;
begin
  if new.amount >= 0 or new.entry_type = 'commission_pending' then return new; end if;
  select p.id into locked_user from public.profiles p where p.id = new.user_id for update;
  select coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0)
    into ledger_balance from public.jc_ledger l where l.user_id = new.user_id;
  current_request_key := nullif(current_setting('app.settlement_request_key', true), '');
  held_balance := private.settlement_reserved_jc(new.user_id, current_request_key);
  if ledger_balance + new.amount - held_balance < -0.000001 then
    raise exception 'insufficient jc (reserved for pending settlement)' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_profile_privilege_changes(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.guard_profile_privilege_changes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() = old.id
     and not private.is_admin()
     and coalesce(current_setting('app.allow_referral_bind', true), '') <> 'on'
     and (
       new.agency_role is distinct from old.agency_role
       or new.role is distinct from old.role
       or new.referrer_id is distinct from old.referrer_id
       or new.parent_id is distinct from old.parent_id
       or new.master_agent_id is distinct from old.master_agent_id
     ) then
    raise exception 'profile role and hierarchy fields can only be changed by an administrator'
      using errcode = '42501';
  end if;
  return new;
end;
$$;


--
-- Name: is_account_active(uuid); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.is_account_active(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
      select coalesce(
        (select account_status is distinct from 'blacklist' from public.profiles where id = p_user_id),
        true
      );
    $$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.agency_role in ('admin', '管理員')
        or p.role in ('admin', 'super_admin')
      )
  );
$$;


--
-- Name: is_effective_member(uuid, date); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.is_effective_member(target_user uuid, month_start date) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select private.month_investment(target_user,month_start)>=100 $$;


--
-- Name: master_month_boost(uuid, date); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.master_month_boost(master_id uuid, month_start date) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select case when private.new_effective_count(master_id,month_start,true)>=5 then .03 else 0 end $$;


--
-- Name: month_investment(uuid, date); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.month_investment(target_user uuid, month_start date) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select coalesce(sum(abs(amount)),0) from public.jc_ledger where user_id=target_user and entry_type in ('private_purchase','p2p_buy') and created_at>=month_start::timestamptz and created_at<(month_start+interval '1 month')::timestamptz $$;


--
-- Name: new_effective_count(uuid, date, boolean); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.new_effective_count(owner_id uuid, month_start date, include_team boolean DEFAULT false) RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select count(*) from public.profiles p where p.created_at>=month_start::timestamptz and p.created_at<(month_start+interval '1 month')::timestamptz and private.is_effective_member(p.id,month_start) and (p.referrer_id=owner_id or (include_team and p.master_agent_id=owner_id)) $$;


--
-- Name: normalize_special_promo_code(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.normalize_special_promo_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.special_promo_code is not null
     and upper(regexp_replace(new.special_promo_code, '[^A-Za-z0-9]', '', 'g')) in ('RWMT88888', 'RWMT888888') then
    new.special_promo_code := 'RWMT88888';
  end if;
  return new;
end;
$$;


--
-- Name: post_referral_commissions(uuid, text, text, numeric, uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: FUNCTION post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text); Type: COMMENT; Schema: private; Owner: -
--

COMMENT ON FUNCTION private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text) IS 'Future rules: L0 self purchase rebate is 3% after any L1/L2 first investment, or promo code REMT88888 bypass; secondary sell only: L1 seller pays L0 13/10000, L2 seller pays L1 13/10000 and L0 7/10000; buys pay no commission.';


--
-- Name: recompute_rwa_shares(numeric); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.recompute_rwa_shares(ae_price numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  r public.private_placements;
  new_total numeric;
  new_per_share numeric;
  target_share_price numeric;
begin
  if ae_price is null or ae_price <= 0 then return; end if;
  for r in
    select * from public.private_placements
    where not coalesce(is_ae_token, false) and is_active and not is_delisted
    for update
  loop
    if r.total_supply is null or r.total_supply <= 0 then continue; end if;

    -- 尚未建立 AE 錨定：以固定 USDT 總估值 valuation 為不變量錨定。
    -- 每份目標 USDT = valuation / total_supply；每份 AE = 每份目標 USDT / AE現價；
    -- rwa_total_value 存固定的 USDT 總估值(=valuation)。僅記參考價、不追溯漲跌。
    if r.rwa_total_value is null or r.rwa_total_value <= 0
       or r.ae_per_share is null or r.ae_per_share <= 0 then
      if r.valuation is null or r.valuation <= 0 then continue; end if;
      target_share_price := r.valuation / r.total_supply;
      new_per_share := round(target_share_price / ae_price, 6);
      if new_per_share <= 0 then continue; end if;
      update public.private_placements
        set ae_per_share = new_per_share,
            rwa_total_value = round(r.valuation, 6),
            ae_per_share_price_ref = ae_price,
            updated_at = now()
        where id = r.id;
      continue;
    end if;

    -- 已有錨定但無參考價（首次遇到）：只記錄參考價，不調整
    if r.ae_per_share_price_ref is null then
      update public.private_placements
        set ae_per_share_price_ref = ae_price, updated_at = now()
        where id = r.id;
      continue;
    end if;

    if ae_price > r.ae_per_share_price_ref then
      -- 上漲：總份額不變，調降單份 AE（每份 AE = 總估值 /(總份額 × AE現價)）
      new_per_share := round(r.rwa_total_value / (r.total_supply * ae_price), 6);
      update public.private_placements
        set ae_per_share = new_per_share,
            ae_per_share_price_ref = ae_price,
            updated_at = now()
        where id = r.id;
    elsif ae_price < r.ae_per_share_price_ref then
      -- 下跌：單份 AE 不變，擴增總份額（釋出更多，available 同步增加）
      new_total := ceil(r.rwa_total_value / (r.ae_per_share * ae_price));
      if new_total > r.total_supply then
        update public.private_placements
          set available = r.available + (new_total - r.total_supply),
              total_supply = new_total,
              ae_per_share_price_ref = ae_price,
              updated_at = now()
          where id = r.id;
      else
        update public.private_placements
          set ae_per_share_price_ref = ae_price, updated_at = now()
          where id = r.id;
      end if;
    end if;
  end loop;
end
$$;


--
-- Name: resolve_commission_rate(text, text, uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.resolve_commission_rate(p_kind text, p_slot text, p_beneficiary uuid, p_asset_mode text) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: rwmt_challenge(bigint, integer); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.rwmt_challenge(p_seed bigint, p_house integer) RETURNS TABLE(question text, answer bigint)
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  t int := (private.rwmt_rand(p_seed, p_house, 0) % 6)::int;
  a bigint := 100 + private.rwmt_rand(p_seed, p_house, 1) % 900;
  b bigint := 100 + private.rwmt_rand(p_seed, p_house, 2) % 900;
  c bigint := 100 + private.rwmt_rand(p_seed, p_house, 3) % 900;
  tmp bigint; k bigint; s bigint; lo bigint; hi bigint;
begin
  if t = 0 then
    question := format('(%s + %s) × %s', a, b, c); answer := (a + b) * c;
  elsif t = 1 then
    if a < b then tmp := a; a := b; b := tmp; end if;
    if a = b then b := case when b > 100 then b - 1 else b end; a := case when a = b then a + 1 else a end; end if;
    question := format('(%s − %s) × %s', a, b, c); answer := (a - b) * c;
  elsif t = 2 then
    question := format('%s × %s − %s', a, b, c); answer := a * b - c;
  elsif t = 3 then
    question := format('%s × %s + %s', a, b, c); answer := a * b + c;
  elsif t = 4 then
    c := 100 + private.rwmt_rand(p_seed, p_house, 4) % 400;
    k := 2 + private.rwmt_rand(p_seed, p_house, 5) % 2;
    s := c * k;
    lo := greatest(100, s - 999); hi := least(999, s - 100);
    a := lo + private.rwmt_rand(p_seed, p_house, 6) % (hi - lo + 1);
    b := s - a;
    question := format('(%s + %s) ÷ %s', a, b, c); answer := k;
  else
    if b < c then tmp := b; b := c; c := tmp; end if;
    if b = c then c := case when c > 100 then c - 1 else c end; b := case when b = c then b + 1 else b end; end if;
    question := format('%s × (%s − %s)', a, b, c); answer := a * (b - c);
  end if;
  return next;
end
$$;


--
-- Name: rwmt_rand(bigint, integer, integer); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.rwmt_rand(p_seed bigint, p_house integer, p_k integer) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select abs(hashtextextended(p_seed::text || ':' || p_house::text || ':' || p_k::text, 0));
$$;


--
-- Name: settle_p2p_match(uuid, uuid, numeric, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.settle_p2p_match(maker_order_key uuid, taker_order_key uuid, match_quantity numeric, match_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
end $$;


--
-- Name: settle_rwa_placement(text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.settle_rwa_placement(asset_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  a public.private_placements;
  e record;
  ae_price numeric;
  final_per_share numeric;
  ae_final numeric;
  usdt_value numeric;
  ae_holding numeric;
  settled_count int := 0;
  total_ae numeric := 0;
  buyer_ledger public.asset_ledger;
  safe_addr text;
begin
  select * into a from public.private_placements where id=asset_key for update;
  if not found then raise exception 'placement not found'; end if;
  if a.is_ae_token then raise exception 'ae token uses its own flow'; end if;
  final_per_share := coalesce(a.ae_per_share, a.price);
  if final_per_share is null or final_per_share <= 0 then raise exception 'ae_per_share not set'; end if;
  ae_price := private.current_ae_price();
  if ae_price is null or ae_price <= 0 then raise exception 'ae price unavailable'; end if;
  select safe_treasury_address into safe_addr from public.platform_config limit 1;
  safe_addr := coalesce(safe_addr, '0x199a423317cE38349574Deb652E4841C29D0De8A');

  for e in
    select * from public.rwa_placement_escrows
    where asset_id=asset_key and status='locked'
    order by created_at for update
  loop
    ae_final := round(e.quantity * final_per_share, 6);
    select coalesce(quantity,0) into ae_holding from public.holdings
      where user_id=e.user_id and asset_id='ae-token-daily' for update;
    if ae_holding < ae_final then
      raise exception 'user % insufficient AE at settlement (need %, have %)', e.user_id, ae_final, ae_holding;
    end if;
    usdt_value := round(ae_final * ae_price, 6);
    update public.holdings set quantity=quantity-ae_final, updated_at=now()
      where user_id=e.user_id and asset_id='ae-token-daily';
    insert into public.asset_ledger(user_id,entry_type,amount,asset_id,quantity,idempotency_key,metadata)
      values(e.user_id,'private_purchase',0,asset_key,e.quantity,'rwa-settle:'||e.id::text,
             jsonb_build_object('settlement','ae','ae_paid',ae_final,'ae_price',ae_price,
               'usdt_value',usdt_value,'gross',usdt_value,'escrow_id',e.id,'phase','settlement'))
      returning * into buyer_ledger;
    insert into public.holdings(user_id,asset_id,quantity,updated_at)
      values(e.user_id,asset_key,e.quantity,now())
      on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
    perform private.post_referral_commissions(e.user_id,asset_key,'private',usdt_value,buyer_ledger.id,'rwa-settle-'||e.id::text||':commission');
    -- Safe 金庫入帳稽核（以 AE 為單位，逐圈存列記錄劃轉）
    insert into public.platform_fee_ledger(source_type,source_id,payer_id,asset_id,amount,treasury_address,metadata)
      values('safe_treasury', buyer_ledger.id, e.user_id, 'ae-token-daily', ae_final, safe_addr,
             jsonb_build_object('unit','ae','placement',asset_key,'escrow_id',e.id,'quantity',e.quantity));
    update public.rwa_placement_escrows
      set status='settled', ae_settled=ae_final, settled_at=now(),
          metadata=metadata||jsonb_build_object('ae_price',ae_price,'usdt_value',usdt_value,'safe_treasury',safe_addr)
      where id=e.id;
    settled_count := settled_count+1;
    total_ae := total_ae+ae_final;
  end loop;

  update public.private_placements
    set is_active=false, market_started_at=coalesce(market_started_at,now()), updated_at=now()
    where id=asset_key;

  return jsonb_build_object('settled_escrows',settled_count,'total_ae_deducted',total_ae,
    'ae_price',ae_price,'final_ae_per_share',final_per_share,'safe_treasury_address',safe_addr);
end
$$;


--
-- Name: settlement_reserved_jc(uuid, text); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.settlement_reserved_jc(p_user_id uuid, p_except_request_key text DEFAULT NULL::text) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(sum(r.jc_amount), 0)::numeric
  from public.settlement_reservations r
  where r.user_id = p_user_id
    and r.action in ('subscribe', 'redeem')
    and r.status = 'pending'
    and (p_except_request_key is null or r.request_key <> p_except_request_key);
$$;


--
-- Name: sync_private_placement_market_state(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.sync_private_placement_market_state() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.market_started_at is null and (new.available <= 0 or not new.is_active or new.ends_at <= now()) then
    new.market_started_at := now();
    new.is_active := false;
    if new.ends_at > now() then new.ends_at := now(); end if;
  end if;
  if new.market_started_at is not null and not new.is_ae_token then
    new.is_active := false;
  end if;
  return new;
end
$$;


--
-- Name: validate_p2p_auto_match(jsonb); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.validate_p2p_auto_match(p_event jsonb) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select b.id
  from public.p2p_orders s
  join public.p2p_orders b
    on b.escrow_chain_order_id in ((p_event->>'orderId')::numeric, (p_event->>'counterOrderId')::numeric)
   and b.escrow_contract_address=private.escrow_event_contract(p_event)
   and b.side='buy'
  where s.escrow_chain_order_id in ((p_event->>'orderId')::numeric, (p_event->>'counterOrderId')::numeric)
    and s.escrow_contract_address=private.escrow_event_contract(p_event)
    and s.side='sell'
    and s.escrow_chain_order_id<>b.escrow_chain_order_id
    and s.escrow_mode='escrow' and b.escrow_mode='escrow'
    and s.status in ('open','partially_filled') and b.status in ('open','partially_filled')
    and s.remaining_quantity > 0 and b.remaining_quantity > 0
    and s.remaining_quantity >= (p_event->>'quantity')::numeric/1e18
    and b.remaining_quantity >= (p_event->>'quantity')::numeric/1e18
    and (p_event->>'currencyReleased')::numeric/1e18 <= coalesce(b.escrow_locked_currency, 0)
    and s.user_id<>b.user_id and s.asset_id=b.asset_id and s.price<=b.price
    and lower(s.escrow_token_address)=lower(p_event->>'assetToken')
    and lower(b.escrow_token_address)=lower(p_event->>'assetToken')
    and lower(s.escrow_currency_address)=lower(p_event->>'currencyToken')
    and lower(b.escrow_currency_address)=lower(p_event->>'currencyToken')
    and round((p_event->>'price')::numeric/1e18,6) in (round(s.price,6), round(b.price,6))
    and round((p_event->>'currencyReleased')::numeric/1e18,6)=case when (p_event->>'quantity')::numeric/1e18=b.remaining_quantity then b.escrow_locked_currency else round((p_event->>'gross')::numeric/1e18,6) end
    and round((p_event->>'currencyReleased')::numeric/1e18,6)<=b.escrow_locked_currency
    and exists(select 1 from public.profiles p where p.id=b.user_id and lower(p.wallet_address)=lower(p_event->>'buyer'))
    and exists(select 1 from public.profiles p where p.id=s.user_id and lower(p.wallet_address)=lower(p_event->>'seller'))
  for update of s,b
$$;


--
-- Name: activate_special_promo_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_special_promo_code(promo text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if upper(regexp_replace(trim(promo), '[^A-Za-z0-9]', '', 'g')) <> 'RWMT88888' then
    raise exception 'unsupported special promo code';
  end if;
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'not authenticated';
  end if;
  update profiles set special_promo_code = 'RWMT88888' where id = auth.uid();
end;
$$;


--
-- Name: admin_apply_asset_payout(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_apply_asset_payout(p_ref_key text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  settlement public.onchain_settlements%rowtype;
  payout_type text;
  payout_amount numeric;
begin
  select * into settlement
  from public.onchain_settlements
  where ref_key = p_ref_key
  for update;

  if not found or settlement.action <> 'admin_payout' then
    raise exception '找不到管理員資產派發紀錄';
  end if;
  if settlement.status <> 'confirmed' then
    raise exception '鏈上交易尚未確認，不能更新網站錢包帳本';
  end if;
  if coalesce(settlement.payload ->> 'accounted', 'false') = 'true' then
    return true;
  end if;

  payout_type := settlement.payload ->> 'assetType';
  payout_amount := (settlement.payload ->> 'amount')::numeric;
  if payout_amount <= 0 then
    raise exception '派發數量必須大於 0';
  end if;

  if payout_type = 'jc' then
    insert into public.jc_ledger (
      user_id, entry_type, amount, idempotency_key, metadata
    ) values (
      settlement.user_id,
      'admin_payout',
      payout_amount,
      'admin-payout:' || settlement.ref_key,
      jsonb_build_object(
        'source', 'admin_hot_wallet',
        'tx_hash', settlement.tx_hash,
        'wallet', settlement.payload ->> 'wallet',
        'admin_payout_ref', settlement.ref_key
      )
    )
    on conflict (idempotency_key) do nothing;
  elsif payout_type in ('ae', 'rwa') then
    if settlement.asset_id is null then
      raise exception 'AE/RWA 派發缺少網站標的帳本 ID';
    end if;
    insert into public.holdings (user_id, asset_id, quantity, updated_at)
    values (settlement.user_id, settlement.asset_id, payout_amount, now())
    on conflict (user_id, asset_id) do update
      set quantity = public.holdings.quantity + excluded.quantity,
          updated_at = now();
  elsif payout_type <> 'usdt' then
    raise exception '不支援的資產派發類型';
  end if;

  update public.onchain_settlements
  set payload = payload || jsonb_build_object('accounted', true),
      updated_at = now()
  where id = settlement.id;

  return true;
end;
$$;


--
-- Name: admin_cap_rwa_placement_available(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_cap_rwa_placement_available(p_placement_id text, p_chain_quantity numeric) RETURNS numeric
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_available numeric;
begin
  if p_chain_quantity is null or p_chain_quantity < 0 then
    raise exception '鏈上可售庫存數量無效';
  end if;

  update public.private_placements as placement
  set available = least(placement.available, p_chain_quantity)
  where placement.id = p_placement_id
    and placement.is_ae_token = false
  returning placement.available into v_available;

  if not found then
    raise exception '找不到對應的 RWA 標的';
  end if;

  return v_available;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: private_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_placements (
    id text NOT NULL,
    name text NOT NULL,
    location text NOT NULL,
    address text NOT NULL,
    image text NOT NULL,
    price numeric(20,6) NOT NULL,
    change numeric(10,4) DEFAULT 0 NOT NULL,
    available numeric(20,4) NOT NULL,
    total_supply numeric(20,4) NOT NULL,
    apy text DEFAULT ''::text NOT NULL,
    valuation numeric(20,2) DEFAULT 0 NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    market_started_at timestamp with time zone,
    price_locked_until timestamp with time zone,
    translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    information text DEFAULT ''::text NOT NULL,
    images text[] DEFAULT '{}'::text[] NOT NULL,
    history jsonb DEFAULT '[]'::jsonb NOT NULL,
    comparables jsonb DEFAULT '[]'::jsonb NOT NULL,
    advantages jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_delisted boolean DEFAULT false NOT NULL,
    is_ae_token boolean DEFAULT false NOT NULL,
    release_interval_seconds integer,
    release_amount_per_interval numeric,
    release_started_at timestamp with time zone,
    ae_token_kind text,
    release_frozen_at timestamp with time zone,
    last_traded_price numeric,
    settlement_currency text DEFAULT 'usdt'::text NOT NULL,
    rwa_total_value numeric,
    ae_per_share numeric(30,6),
    ae_per_share_price_ref numeric,
    token_name text,
    token_symbol text,
    token_decimals integer,
    token_address text,
    bonus_normal_price numeric,
    CONSTRAINT private_placements_ae_token_kind_check CHECK ((ae_token_kind = ANY (ARRAY['daily'::text, 'bonus'::text]))),
    CONSTRAINT private_placements_apy_length CHECK ((char_length(apy) <= 80)),
    CONSTRAINT private_placements_available_check CHECK ((available >= (0)::numeric)),
    CONSTRAINT private_placements_check CHECK (((total_supply > (0)::numeric) AND (available <= total_supply))),
    CONSTRAINT private_placements_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT private_placements_settlement_currency_check CHECK ((settlement_currency = ANY (ARRAY['usdt'::text, 'ae'::text])))
);


--
-- Name: COLUMN private_placements.is_ae_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.private_placements.is_ae_token IS 'True for AE token rounds: a special placement type released in fixed batches over time instead of one lump subscription.';


--
-- Name: COLUMN private_placements.release_interval_seconds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.private_placements.release_interval_seconds IS 'For AE token rounds: seconds between each release batch.';


--
-- Name: COLUMN private_placements.release_amount_per_interval; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.private_placements.release_amount_per_interval IS 'For AE token rounds: units released per interval.';


--
-- Name: COLUMN private_placements.release_started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.private_placements.release_started_at IS 'For AE token rounds: timestamp the release schedule began, used to compute released-so-far without a cron job.';


--
-- Name: admin_change_secondary_price(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_change_secondary_price(asset_key text, new_price numeric) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  admin_email text;
  old_price numeric;
  price_change numeric;
  repriced_count integer := 0;
  auto_matched_count integer := 0;
  best_bid public.p2p_orders;
  best_ask public.p2p_orders;
  fill_qty numeric;
  ae_token boolean;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if new_price is null or new_price <= 0 then
    raise exception 'invalid price';
  end if;

  select price, is_ae_token
    into old_price, ae_token
  from public.private_placements
  where id = asset_key
    and (market_started_at is not null or is_active = false or ends_at <= now())
  for update;

  if old_price is null then
    raise exception 'asset not in secondary market';
  end if;

  if ae_token then
    raise exception 'AE 代幣價格由買賣雙方於掛單時自訂，不支援管理員統一改價';
  end if;

  price_change := case
    when old_price = 0 then 0
    else round(((new_price - old_price) / old_price) * 100, 2)
  end;

  update public.private_placements
  set price = new_price,
      change = price_change,
      price_locked_until = now() + interval '1 minute',
      updated_at = now()
  where id = asset_key
  returning * into result;

  update public.p2p_orders
  set price = new_price,
      updated_at = now()
  where asset_id = asset_key
    and status in ('open', 'partially_filled');
  get diagnostics repriced_count = row_count;

  loop
    exit when auto_matched_count >= 1000;
    select o.* into best_bid from public.p2p_orders o
      where o.asset_id = asset_key and o.side = 'buy' and o.status in ('open', 'partially_filled')
      order by o.price desc, o.created_at asc, o.id asc
      limit 1 for update skip locked;
    exit when not found;
    select o.* into best_ask from public.p2p_orders o
      where o.asset_id = asset_key and o.side = 'sell' and o.status in ('open', 'partially_filled')
      order by o.price asc, o.created_at asc, o.id asc
      limit 1 for update skip locked;
    exit when not found;
    exit when best_bid.user_id = best_ask.user_id;
    exit when best_bid.price < best_ask.price;
    fill_qty := least(best_bid.remaining_quantity, best_ask.remaining_quantity);
    exit when round(best_ask.price * fill_qty, 6) < 2;
    perform private.settle_p2p_match(
      best_ask.id,
      best_bid.id,
      fill_qty,
      'admin-reprice:' || asset_key || ':' || auto_matched_count::text
    );
    auto_matched_count := auto_matched_count + 1;
  end loop;

  insert into public.market_price_snapshots(asset_id, price, recorded_by, recorded_at)
  values(result.id, new_price, auth.uid(), clock_timestamp());

  select email into admin_email
  from public.profiles
  where id = auth.uid();

  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values(
    auth.uid(),
    coalesce(admin_email, ''),
    'secondary.price.update',
    'private_placement',
    result.id,
    jsonb_build_object(
      'old_price', old_price,
      'new_price', new_price,
      'change_percent', price_change,
      'locked_until', result.price_locked_until,
      'price_snapshot_recorded_at', clock_timestamp(),
      'repriced_open_orders', repriced_count,
      'auto_matched_on_reprice', auto_matched_count
    )
  );

  return result;
end;
$$;


--
-- Name: admin_commission_discrepancies(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_commission_discrepancies() RETURNS TABLE(beneficiary_id uuid, email text, nickname text, display_name text, agency_role text, owed numeric, paid numeric, diff numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  with owed_cte as (
    select c.beneficiary_id as bid, sum(c.commission_amount) as owed
    from public.commission_logs c
    where c.paid_at is not null and c.beneficiary_id is not null
    group by c.beneficiary_id
  ),
  paid_cte as (
    select l.user_id as bid, sum(l.amount) as paid
    from public.jc_ledger l
    where l.entry_type in ('commission_payout', 'commission_reversal')
    group by l.user_id
  ),
  merged as (
    select
      coalesce(o.bid, p.bid) as bid,
      coalesce(o.owed, 0)::numeric as owed,
      coalesce(p.paid, 0)::numeric as paid
    from owed_cte o
    full outer join paid_cte p on p.bid = o.bid
  )
  select
    m.bid,
    pr.email,
    pr.nickname,
    pr.display_name,
    pr.agency_role,
    round(m.owed, 6) as owed,
    round(m.paid, 6) as paid,
    round(m.paid - m.owed, 6) as diff
  from merged m
  join public.profiles pr on pr.id = m.bid
  where abs(m.paid - m.owed) > 0.000001
  order by abs(m.paid - m.owed) desc;
end;
$$;


--
-- Name: admin_commission_rate_audit(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_commission_rate_audit(p_since timestamp with time zone DEFAULT '2026-10-14 08:00:00+08'::timestamp with time zone) RETURNS TABLE(kind text, source_ledger_id uuid, beneficiary_id uuid, bonus_type text, actual_rate numeric, expected_rate numeric, actual_amount numeric, expected_amount numeric, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: admin_complete_redemption(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_complete_redemption(order_id uuid, tx_hash text, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare o public.redemption_orders; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if tx_hash is null or length(trim(tx_hash)) < 10 then raise exception 'invalid tx hash'; end if;
  select * into o from public.redemption_orders where id = order_id for update;
  if not found then raise exception 'order not found'; end if;
  if o.status <> 'pending' then raise exception 'order already resolved'; end if;

  update public.redemption_orders
    set status='completed', tx_hash=admin_complete_redemption.tx_hash, admin_id=auth.uid(),
        admin_note=note, resolved_at=now(), updated_at=now()
    where id = order_id;

  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
    values(auth.uid(),coalesce(u_email,''),'redemption.complete','redemption_orders',order_id::text,
      jsonb_build_object('tx_hash',tx_hash,'usdt_amount',o.usdt_amount,'user_id',o.user_id));

  return jsonb_build_object('order_id',o.id,'status','completed','tx_hash',tx_hash);
end
$$;


--
-- Name: admin_create_placement(text, text, text, text, text[], numeric, numeric, numeric, numeric, text, text, jsonb, timestamp with time zone, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_create_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  admin_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if trim(p_id)='' or trim(p_name)='' or trim(p_location)='' or trim(p_address)=''
    or cardinality(p_images)=0 or p_price<=0 or p_valuation<=0 or p_total_supply<=0
    or p_available<0 or p_available>p_total_supply
    or char_length(trim(coalesce(p_apy,'')))>80 or p_ends_at<=now()
    or exists(select 1 from unnest(p_images) u where u !~ '^https://')
    or jsonb_typeof(coalesce(p_history,'[]')) <> 'array'
    or jsonb_typeof(coalesce(p_comparables,'[]')) <> 'array'
    or jsonb_typeof(coalesce(p_advantages,'[]')) <> 'array'
  then raise exception 'invalid values'; end if;

  insert into public.private_placements(
    id,name,location,address,image,images,price,valuation,total_supply,available,apy,
    information,translations,ends_at,is_active,market_started_at,price_locked_until,
    history,comparables,advantages
  ) values (
    trim(p_id),trim(p_name),trim(p_location),trim(p_address),p_images[1],p_images,p_price,
    p_valuation,p_total_supply,p_available,trim(coalesce(p_apy,'')),coalesce(p_information,''),
    p_translations,p_ends_at,true,null,null,coalesce(p_history,'[]'),
    coalesce(p_comparables,'[]'),coalesce(p_advantages,'[]')
  ) returning * into result;

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,'create','private_placement',result.id,
    jsonb_build_object('name',result.name,'valuation',result.valuation,'total_supply',result.total_supply,'available',result.available));
  return result;
end;
$$;


--
-- Name: admin_deactivate_placement(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_deactivate_placement(placement_id text) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements; admin_email text;
  refunded_total numeric := 0; rec record;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  update public.private_placements set is_active=false, is_delisted=true, updated_at=now()
  where id=placement_id and is_delisted=false returning * into result;
  if result.id is null then raise exception 'placement not found or already delisted'; end if;

  -- cancel any open secondary orders on this asset
  update public.p2p_orders set status='cancelled', updated_at=now()
    where asset_id=placement_id and status in ('open','partially_filled');

  -- refund each subscriber their JC principal along the original path
  for rec in
    select user_id, -coalesce(sum(amount),0) as principal
    from public.jc_ledger where asset_id=placement_id and entry_type='private_purchase'
    group by user_id having -coalesce(sum(amount),0) > 0
  loop
    if not exists(select 1 from public.jc_ledger where idempotency_key='delist-refund:'||placement_id||':'||rec.user_id) then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
        values(rec.user_id,'refund',rec.principal,placement_id,'delist-refund:'||placement_id||':'||rec.user_id,
               jsonb_build_object('reason','delist','placement',placement_id));
      refunded_total := refunded_total + rec.principal;
    end if;
  end loop;

  -- clear holdings of this delisted asset
  delete from public.holdings where asset_id=placement_id;

  update public.platform_config set featured_asset_id=null where featured_asset_id=placement_id;
  select email into admin_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values (auth.uid(), coalesce(admin_email,''), 'private_placement.deactivate','private_placement',placement_id,
          jsonb_build_object('name',result.name,'refunded_jc',refunded_total));
  return result;
end $$;


--
-- Name: admin_delete_announcement(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_announcement(announcement_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare deleted_title text; admin_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; delete from public.platform_announcements where id=announcement_id returning title into deleted_title; if deleted_title is null then raise exception 'announcement not found'; end if; select email into admin_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(admin_email,''),'announcement.delete','announcement',announcement_id::text,jsonb_build_object('title',deleted_title)); end $$;


--
-- Name: admin_delete_background_push_log(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_delete_background_push_log(push_log_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  deleted_count integer;
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and agency_role in ('admin', 'super_admin', '管理員')
  ) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  delete from public.background_push_logs
  where id = push_log_id;

  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;


--
-- Name: admin_end_ae_token_bonus_round(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_end_ae_token_bonus_round(p_asset_id text) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  admin_email text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  update public.private_placements
  set release_frozen_at=now(), updated_at=now()
  where id=p_asset_id and is_ae_token=true and ae_token_kind='bonus' and is_active=true and release_frozen_at is null
  returning * into result;

  if result.id is null then
    raise exception 'bonus round not found or already ended';
  end if;

  update public.private_placements
  set is_active=true, updated_at=now()
  where id='ae-token-daily';

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,'end','ae_token_bonus_round',result.id,
    jsonb_build_object('available_remaining',result.available,'ended_at',result.release_frozen_at));

  return result;
end;
$$;


--
-- Name: admin_end_private_placement(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_end_private_placement(placement_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a public.private_placements; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  select * into a from public.private_placements where id=placement_id for update;
  if not found or a.market_started_at is not null then raise exception 'placement not found or already in market'; end if;
  update public.private_placements
    set market_started_at=now(), ends_at=least(ends_at,now()),
        is_active=case when a.is_ae_token then false else is_active end, updated_at=now()
    where id=placement_id;
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
    values(auth.uid(),coalesce(u_email,''),'private_placement.end_now','private_placement',placement_id,
           jsonb_build_object('secondary_market_enabled',true));
end $$;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    display_name text,
    wallet_address text,
    balance numeric(20,2) DEFAULT 0 NOT NULL,
    agency_role text DEFAULT '一般用戶'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sign_in_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    promo_code text,
    referrer_id uuid,
    master_agent_id uuid,
    role_approved_at timestamp with time zone,
    last_login_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_seen_at timestamp with time zone DEFAULT now(),
    role text DEFAULT 'user'::text,
    parent_id uuid,
    nickname text,
    privy_id text,
    account_status text DEFAULT 'whitelist'::text NOT NULL,
    funds_frozen_at timestamp with time zone,
    funds_seized_at timestamp with time zone,
    funds_seized_amount numeric DEFAULT 0 NOT NULL,
    special_promo_code text,
    CONSTRAINT profiles_account_status_check CHECK ((account_status = ANY (ARRAY['whitelist'::text, 'blacklist'::text]))),
    CONSTRAINT profiles_balance_check CHECK ((balance >= (0)::numeric)),
    CONSTRAINT profiles_no_self_referral CHECK ((((referrer_id IS NULL) OR (referrer_id <> id)) AND ((master_agent_id IS NULL) OR (master_agent_id <> id)))),
    CONSTRAINT profiles_promo_code_format CHECK (((promo_code IS NULL) OR (promo_code ~ '^[A-Z0-9]{9}$'::text)))
);


--
-- Name: admin_freeze_account(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_freeze_account(p_user_id uuid) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
    declare result public.profiles;
    begin
      if not private.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
      update public.profiles set account_status = 'blacklist', funds_frozen_at = coalesce(funds_frozen_at, now())
        where id = p_user_id returning * into result;
      if result.id is null then raise exception 'user not found'; end if;
      return result;
    end;$$;


--
-- Name: admin_get_jc_balance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_jc_balance(p_user_id uuid) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v numeric;
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select greatest(coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0)
    - private.settlement_reserved_jc(p_user_id), 0)::numeric into v
  from public.jc_ledger l where l.user_id = p_user_id;
  return coalesce(v, 0);
end;
$$;


--
-- Name: admin_get_user_town_transactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_user_town_transactions(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not public.is_admin() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', 'town-' || o.id::text,
          'kind', case when o.result = 'bomb' then 'bomb' else 'ae' end,
          'house', o.house_index,
          'amount', case when o.result = 'bomb' then abs(o.jc_penalty) else 1 end,
          'tx_hash', o.ae_tx_hash,
          'prize_status', o.prize_status,
          'created_at', o.created_at,
          'paid_at', o.ae_paid_at
        )
        order by o.created_at desc
      ),
      '[]'::jsonb
    )
    from public.rwmt_town_opens o
    where o.user_id = p_user_id
      and o.result = 'ae'
  );
end;
$$;


--
-- Name: admin_get_user_wallet_town_transactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_user_wallet_town_transactions(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not private.is_admin() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', 'town-' || o.id::text,
      'kind', case when o.result = 'bomb' then 'bomb' else 'ae' end,
      'house', o.house_index,
      'amount', case when o.result = 'bomb' then abs(o.jc_penalty) else 1 end,
      'net', case when o.result = 'bomb' then -abs(o.jc_penalty) else 1 end,
      'tx_hash', o.ae_tx_hash,
      'status', case when o.result = 'ae' then case when o.prize_status = 'paid' then 'confirmed' else 'pending' end else 'confirmed' end,
      'created_at', o.created_at,
      'paid_at', o.ae_paid_at
    ) order by o.created_at desc), '[]'::jsonb)
    from public.rwmt_town_opens o
    where o.user_id = p_user_id and (o.result = 'bomb' or o.result = 'ae')
  );
end;
$$;


--
-- Name: admin_get_wallet_balance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_wallet_balance(target_user_id uuid) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return (
    select coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0)::numeric
    from public.asset_ledger l
    where l.user_id = target_user_id
  );
end;
$$;


--
-- Name: admin_list_background_push_logs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_background_push_logs() RETURNS TABLE(id uuid, title text, body text, sent_count integer, failed_count integer, removed_count integer, target_count integer, subscriber_count integer, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    logs.id,
    logs.title,
    logs.body,
    logs.sent_count,
    logs.failed_count,
    logs.removed_count,
    logs.target_count,
    logs.subscriber_count,
    logs.created_at
  from public.background_push_logs as logs
  order by logs.created_at desc;
end;
$$;


--
-- Name: admin_list_commission_people(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_commission_people(asset_mode_text text) RETURNS TABLE(user_id uuid, email text, display_name text, agency_role text, private_rate numeric, secondary_rate numeric, default_private_rate numeric, default_secondary_rate numeric, self_private_rate numeric, l1_private_rate numeric, l2_private_rate numeric, self_secondary_rate numeric, l1_secondary_rate numeric, l2_secondary_rate numeric, self_rebate_unlocked boolean)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$ select p.id,p.email,coalesce(nullif(btrim(p.nickname),''),nullif(btrim(p.display_name),''),split_part(p.email,'@',1)),p.agency_role,o.private_rate,o.secondary_rate,s.private_rate,s.secondary_rate,o.self_private_rate,o.l1_private_rate,o.l2_private_rate,o.self_secondary_rate,o.l1_secondary_rate,o.l2_secondary_rate, (upper(regexp_replace(coalesce(p.special_promo_code, p.promo_code, ''), '[^A-Z0-9]', '', 'g')) = 'RWMT88888' or exists (select 1 from public.profiles l1 left join public.profiles l2 on l2.referrer_id=l1.id or l2.parent_id=l1.id join public.jc_ledger j on j.user_id in (l1.id,l2.id) where (l1.referrer_id=p.id or l1.parent_id=p.id) and j.entry_type='private_purchase' and j.amount < 0)) from public.profiles p left join public.commission_user_overrides o on o.user_id=p.id and o.asset_mode=asset_mode_text left join public.commission_settings s on s.agency_role=p.agency_role and s.asset_mode=asset_mode_text where private.is_admin() order by coalesce(nullif(btrim(p.nickname),''),nullif(btrim(p.display_name),''),split_part(p.email,'@',1)),p.email$$;


--
-- Name: admin_list_platform_fees(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_platform_fees() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result jsonb;
begin
  if not private.is_admin() then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'source_type',f.source_type,'payer_id',f.payer_id,'payer_email',p.email,'asset_id',f.asset_id,'amount',f.amount,'treasury_address',f.treasury_address,'metadata',f.metadata,'created_at',f.created_at) order by f.created_at desc),'[]'::jsonb) into result from public.platform_fee_ledger f join public.profiles p on p.id=f.payer_id;
  return result;
end$$;


--
-- Name: admin_list_private_placements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_private_placements() RETURNS SETOF public.private_placements
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.*
  FROM public.private_placements AS p
  WHERE p.updated_at >= TIMESTAMPTZ '2026-10-04 11:57:00+08'
  ORDER BY p.created_at;
END;
$$;


--
-- Name: FUNCTION admin_list_private_placements(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_list_private_placements() IS 'Admin-only placement list, restricted to rows updated since 2026-10-04 11:57 Asia/Taipei.';


--
-- Name: admin_list_wallet_balances(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_wallet_balances() RETURNS TABLE(user_id uuid, balance numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select p.id,
    coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0)::numeric
  from public.profiles p
  left join public.asset_ledger l on l.user_id = p.id
  group by p.id;
end;
$$;


--
-- Name: commission_payout_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_payout_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    role_filter text,
    recipient_count integer DEFAULT 0 NOT NULL,
    total_amount numeric DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_pay_pending_commissions(text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_pay_pending_commissions(role_text text DEFAULT NULL::text, recipient_ids uuid[] DEFAULT NULL::uuid[]) RETURNS public.commission_payout_batches
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare b public.commission_payout_batches; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if role_text is not null and role_text not in ('總代理','代理') then raise exception 'invalid role'; end if;
  insert into public.commission_payout_batches(scope,role_filter,created_by)
    values(case when recipient_ids is not null then 'selected' when role_text is not null then 'role' else 'all' end,role_text,auth.uid()) returning * into b;
  with eligible as (
    select c.id,c.commission_amount,c.beneficiary_id from public.commission_logs c
    join public.profiles p on p.id=c.beneficiary_id
    where c.paid_at is null and c.beneficiary_id is not null
      and (role_text is null or (role_text='總代理' and p.agency_role='總代理') or (role_text='代理' and p.agency_role in ('代理','一代代理','二代代理')))
      and (recipient_ids is null or c.beneficiary_id=any(recipient_ids)) for update),
  entries as (
    insert into public.jc_ledger(user_id,entry_type,amount,idempotency_key,metadata)
    select beneficiary_id,'commission_payout',commission_amount,'commission-payout:'||id::text,jsonb_build_object('commission_log_id',id,'payout_batch_id',b.id)
    from eligible on conflict(idempotency_key) do nothing returning user_id,amount)
  update public.commission_logs c set paid_at=now(),payout_batch_id=b.id from eligible e
    where c.id=e.id and exists(select 1 from public.jc_ledger l where l.idempotency_key='commission-payout:'||e.id::text);
  update public.commission_payout_batches set
    recipient_count=(select count(distinct beneficiary_id) from public.commission_logs where payout_batch_id=b.id),
    total_amount=(select coalesce(sum(commission_amount),0) from public.commission_logs where payout_batch_id=b.id)
    where id=b.id returning * into b;
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
    values(auth.uid(),coalesce(u_email,''),'commission.payout','commission_payout_batch',b.id::text,jsonb_build_object('scope',b.scope,'role',role_text,'recipients',b.recipient_count,'total',b.total_amount));
  return b;
end $$;


--
-- Name: platform_announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    translations jsonb DEFAULT '{}'::jsonb NOT NULL,
    background_push boolean DEFAULT false NOT NULL,
    CONSTRAINT platform_announcements_content_check CHECK (((char_length(TRIM(BOTH FROM content)) >= 1) AND (char_length(TRIM(BOTH FROM content)) <= 2000))),
    CONSTRAINT platform_announcements_title_check CHECK (((char_length(TRIM(BOTH FROM title)) >= 1) AND (char_length(TRIM(BOTH FROM title)) <= 120)))
);


--
-- Name: admin_publish_announcement(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_publish_announcement(title_text text, content_text text, translations_json jsonb DEFAULT '{}'::jsonb) RETURNS public.platform_announcements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  r public.platform_announcements;
  u_email text;
  clean_translations jsonb := case when jsonb_typeof(coalesce(translations_json, '{}'::jsonb)) = 'object' then coalesce(translations_json, '{}'::jsonb) else '{}'::jsonb end;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if trim(coalesce(title_text,''))='' or trim(coalesce(content_text,''))='' or char_length(title_text)>120 or char_length(content_text)>2000 or title_text like '%�%' or content_text like '%�%' then raise exception 'invalid announcement'; end if;
  insert into public.platform_announcements(title, content, translations, created_by, is_active)
  values (trim(title_text), trim(content_text), clean_translations, auth.uid(), true)
  returning * into r;
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, auth.jwt()->>'email',''), 'announcement.publish', 'announcement', r.id::text, jsonb_build_object('title', r.title));
  return r;
end
$$;


--
-- Name: admin_rebind_referral(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_rebind_referral(target_user_id uuid, new_promo_code text, reason_text text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare target public.profiles; sponsor public.profiles; result public.profiles; admin_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if length(trim(reason_text))<5 then raise exception 'reason required'; end if; select * into target from public.profiles where id=target_user_id for update; if not found then raise exception 'user unavailable'; end if; select * into sponsor from public.profiles where upper(promo_code)=upper(trim(new_promo_code)) and agency_role in ('代理','一代代理','二代代理','總代理'); if not found or sponsor.id=target_user_id then raise exception 'invalid sponsor'; end if; if target.agency_role in ('代理','一代代理','二代代理') and sponsor.agency_role<>'總代理' then raise exception 'agent must bind to master agent'; end if; update public.profiles set referrer_id=case when agency_role in ('代理','一代代理','二代代理') then referrer_id else sponsor.id end,master_agent_id=case when sponsor.agency_role='總代理' then sponsor.id else sponsor.master_agent_id end where id=target_user_id returning * into result; insert into public.referral_binding_logs(user_id,old_referrer_id,new_referrer_id,old_master_agent_id,new_master_agent_id,action,reason,actor_id) values(target.id,target.referrer_id,result.referrer_id,target.master_agent_id,result.master_agent_id,'admin_rebind',trim(reason_text),auth.uid()); select email into admin_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),admin_email,'admin_rebind_referral','profile',target_user_id::text,jsonb_build_object('promo_code',upper(trim(new_promo_code)),'reason',reason_text)); return result; end $$;


--
-- Name: admin_rebind_referral_by_email(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_rebind_referral_by_email(target_email text, new_promo_code text, reason_text text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare target_id uuid; normalized_email text:=lower(trim(target_email)); begin if not private.is_admin() then raise exception 'not authorized'; end if; if normalized_email='' then raise exception 'email required'; end if; select id into target_id from public.profiles where lower(email)=normalized_email; if not found then raise exception 'user unavailable'; end if; return public.admin_rebind_referral(target_id,new_promo_code,reason_text); end $$;


--
-- Name: admin_reclaim_account_funds(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reclaim_account_funds(p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
    declare jc_bal numeric; result public.profiles;
    begin
      if not private.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
      select coalesce(sum(amount) filter (where entry_type <> 'commission_pending'), 0) into jc_bal
        from public.jc_ledger where user_id = p_user_id;
      if jc_bal > 0 then
        insert into public.jc_ledger (user_id, entry_type, amount, metadata)
        values (p_user_id, 'admin_seize', -jc_bal, jsonb_build_object('reason','admin_blacklist_reclaim','admin_id', auth.uid()));
      end if;
      update public.profiles set account_status = 'blacklist', funds_seized_at = now(),
        funds_seized_amount = coalesce(funds_seized_amount, 0) + greatest(jc_bal, 0)
        where id = p_user_id returning * into result;
      if result.id is null then raise exception 'user not found'; end if;
      return jsonb_build_object('profile', to_jsonb(result), 'seized_amount', greatest(jc_bal, 0));
    end;$$;


--
-- Name: admin_reconciliation_report(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reconciliation_report() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_issues jsonb := '[]'::jsonb;
  v_ids text[];
  v_count int;
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'completed' and (tx_hash is null or length(tx_hash) < 10) limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_completed_no_tx','severity','critical','title','已完成贖回但缺少 USDT 撥款 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o where o.status = 'rejected'
        and not exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_rejected_no_refund','severity','critical','title','已拒絕贖回但沒有退回 JC','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select o.id from public.redemption_orders o where o.status = 'completed'
        and exists (select 1 from public.jc_ledger l where l.idempotency_key = o.idempotency_key || ':refund') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_paid_and_refunded','severity','critical','title','贖回同時撥款又退款（重複給付風險）','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(id::text), '{}') into v_count, v_ids
  from (select id from public.redemption_orders where status = 'pending' and created_at < now() - interval '60 minutes' limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','redemption_pending_stale','severity','warning','title','贖回待審核超過 60 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select ref_key from public.onchain_settlements where status = 'confirmed' and (tx_hash is null or length(tx_hash) < 10) and action not in ('wire_contracts') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_confirmed_no_tx','severity','critical','title','鏈上結算標示成功但缺少 Tx Hash','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(ref_key), '{}') into v_count, v_ids
  from (select ref_key from public.onchain_settlements where status = 'failed' or (status = 'pending' and updated_at < now() - interval '10 minutes') limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','settlement_stuck','severity','warning','title','鏈上結算失敗或卡住超過 10 分鐘','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'private_purchase' and l.created_at >= timestamptz '2026-10-08 00:00:00+00' and l.created_at < now() - interval '15 minutes'
          and not exists (select 1 from public.onchain_settlements s where s.ref_key = 'subscribe:' || l.idempotency_key)
          and not exists (select 1 from public.jc_ledger r where r.entry_type = 'refund' and (r.metadata ->> 'source_key') = l.idempotency_key)
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','purchase_no_settlement','severity','warning','title','認購已扣款但沒有鏈上結算紀錄','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(idempotency_key), '{}') into v_count, v_ids
  from (select l.idempotency_key from public.jc_ledger l
        where l.entry_type = 'vault_buy' and l.created_at >= timestamptz '2026-10-08 00:00:00+00' and l.created_at < now() - interval '15 minutes'
          and not exists (select 1 from public.onchain_settlements s
                          where s.ref_key = 'mint_jc:' || regexp_replace(l.idempotency_key, ':jc$', '') and s.status = 'confirmed')
        limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','vault_buy_no_settlement','severity','critical','title','金庫買幣已記帳但沒有成功的鏈上發幣','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*), coalesce(array_agg(user_id::text), '{}') into v_count, v_ids
  from (select user_id from public.jc_ledger where entry_type <> 'commission_pending'
        group by user_id having sum(amount) < -0.000001 limit 20) t;
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','negative_jc_balance','severity','critical','title','用戶 JC 可用餘額為負數','count',v_count,'samples',to_jsonb(v_ids)); end if;

  select count(*) into v_count from public.admin_commission_discrepancies();
  if v_count > 0 then v_issues := v_issues || jsonb_build_object('code','commission_mismatch','severity','warning','title','分潤應發與帳本實發不一致（可在派發頁沖正）','count',v_count,'samples','[]'::jsonb); end if;

  return jsonb_build_object('generated_at', now(), 'ok', jsonb_array_length(v_issues) = 0, 'issues', v_issues);
end;
$_$;


--
-- Name: admin_reject_redemption(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reject_redemption(order_id uuid, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  o public.redemption_orders;
  u_email text;
  v_note text := nullif(btrim(coalesce(note, '')), '');
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_note is null or length(v_note) < 2 then raise exception 'reason required'; end if;
  select * into o from public.redemption_orders where id = order_id for update;
  if not found then raise exception 'order not found'; end if;
  if o.status <> 'pending' then raise exception 'order already resolved'; end if;
  insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata)
  values (o.user_id, 'redemption_refund', o.jc_amount, o.idempotency_key || ':refund',
          jsonb_build_object('order_id', o.id, 'reason', 'rejected', 'note', v_note))
  on conflict (idempotency_key) do nothing;
  update public.redemption_orders
  set status = 'rejected', admin_id = auth.uid(), admin_note = v_note, resolved_at = now(), updated_at = now()
  where id = order_id;
  update public.settlement_reservations
  set status = 'released', updated_at = now()
  where request_key = o.idempotency_key and action = 'redeem' and status = 'pending';
  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, ''), 'redemption.reject', 'redemption_orders', order_id::text,
          jsonb_build_object('jc_amount', o.jc_amount, 'user_id', o.user_id, 'note', v_note));
  return jsonb_build_object('order_id', o.id, 'status', 'rejected');
end;
$$;


--
-- Name: admin_reset_ae_token(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_reset_ae_token() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  admin_email text;
  ae_ids text[];
  cancelled_orders integer;
  wiped_holdings integer;
  delisted_placements integer;
  refunded_total numeric := 0;
  rec record;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  select array_agg(id) into ae_ids from public.private_placements where is_ae_token = true;
  if ae_ids is null then
    raise exception 'no ae token found';
  end if;

  with cancelled as (
    update public.p2p_orders
    set status = 'cancelled', updated_at = now()
    where asset_id = any(ae_ids) and status in ('open', 'partially_filled')
    returning 1
  )
  select count(*) into cancelled_orders from cancelled;

  for rec in
    select user_id, asset_id, -coalesce(sum(amount), 0) as principal
    from public.jc_ledger
    where asset_id = any(ae_ids) and entry_type = 'private_purchase'
    group by user_id, asset_id
    having -coalesce(sum(amount), 0) > 0
  loop
    if not exists (
      select 1 from public.jc_ledger
      where idempotency_key = 'ae-reset-refund:' || rec.asset_id || ':' || rec.user_id
    ) then
      insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
        values (rec.user_id, 'refund', rec.principal, rec.asset_id,
                'ae-reset-refund:' || rec.asset_id || ':' || rec.user_id,
                jsonb_build_object('reason', 'ae_reset', 'placement', rec.asset_id));
      refunded_total := refunded_total + rec.principal;
    end if;
  end loop;

  with wiped as (
    delete from public.holdings where asset_id = any(ae_ids) returning 1
  )
  select count(*) into wiped_holdings from wiped;

  with delisted as (
    update public.private_placements
    set is_active = false, is_delisted = true, available = 0, updated_at = now()
    where id = any(ae_ids)
    returning 1
  )
  select count(*) into delisted_placements from delisted;

  select email into admin_email from auth.users where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), admin_email, 'reset', 'ae_token', 'ae-token-daily',
    jsonb_build_object('cancelled_orders', cancelled_orders, 'wiped_holdings', wiped_holdings,
      'delisted_placements', delisted_placements, 'refunded_jc', refunded_total));

  return jsonb_build_object('cancelled_orders', cancelled_orders, 'wiped_holdings', wiped_holdings,
    'delisted_placements', delisted_placements, 'refunded_jc', refunded_total);
end;
$$;


--
-- Name: admin_restore_whitelist(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_restore_whitelist(p_user_id uuid) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
    declare result public.profiles;
    begin
      if not private.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
      update public.profiles set account_status = 'whitelist', funds_frozen_at = null
        where id = p_user_id returning * into result;
      if result.id is null then raise exception 'user not found'; end if;
      return result;
    end;$$;


--
-- Name: admin_rwa_escrow_summary(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_rwa_escrow_summary(placement_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  locked_count int;
  locked_ae numeric;
  locked_qty numeric;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  select count(*), coalesce(sum(ae_locked),0), coalesce(sum(quantity),0)
    into locked_count, locked_ae, locked_qty
  from public.rwa_placement_escrows
  where asset_id=placement_id and status='locked';
  return jsonb_build_object('locked_count',locked_count,'locked_ae',locked_ae,'locked_quantity',locked_qty);
end
$$;


--
-- Name: admin_save_ae_token_daily(numeric, integer, numeric, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text DEFAULT 'AE 代幣'::text, p_information text DEFAULT ''::text, p_image text DEFAULT '/images/ae-token.png'::text) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  admin_email text;
  daily_id constant text := 'ae-token-daily';
  existed boolean;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_price is null or p_price<=0 then raise exception 'invalid price'; end if;
  if p_release_interval_seconds is null or p_release_interval_seconds<=0 then raise exception 'invalid release interval'; end if;
  if p_release_amount_per_interval is null or p_release_amount_per_interval<=0 then raise exception 'invalid release amount'; end if;
  if trim(coalesce(p_name,''))='' then raise exception 'name required'; end if;

  select exists(select 1 from public.private_placements where id=daily_id) into existed;

  if existed then
    update public.private_placements
    set price=p_price, valuation=p_price*total_supply, name=trim(p_name),
        information=coalesce(p_information,''), image=p_image, images=array[p_image],
        release_interval_seconds=p_release_interval_seconds,
        release_amount_per_interval=p_release_amount_per_interval,
        is_delisted=false,
        is_active=true,
        available=case when is_delisted then total_supply else available end,
        market_started_at=case when is_delisted then now() else market_started_at end,
        release_started_at=case when is_delisted then now() else release_started_at end,
        ends_at=case when is_delisted then 'infinity'::timestamptz else ends_at end,
        updated_at=now()
    where id=daily_id
    returning * into result;
  else
    insert into public.private_placements(
      id,name,location,address,image,images,price,valuation,total_supply,available,apy,
      information,translations,ends_at,is_active,market_started_at,price_locked_until,
      history,comparables,advantages,
      is_ae_token,ae_token_kind,release_interval_seconds,release_amount_per_interval,release_started_at
    ) values (
      daily_id, trim(p_name), 'AE 代幣', 'AE 代幣', p_image, array[p_image], p_price,
      p_price*1e11, 1e11, 1e11, '',
      coalesce(p_information,''), '{}'::jsonb, 'infinity'::timestamptz, true, now(), null,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      true, 'daily', p_release_interval_seconds, p_release_amount_per_interval, now()
    ) returning * into result;
  end if;

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,case when existed then 'update' else 'create' end,'ae_token_daily',result.id,
    jsonb_build_object(
      'price',result.price,
      'release_interval_seconds',result.release_interval_seconds,
      'release_amount_per_interval',result.release_amount_per_interval
    ));

  return result;
end;
$$;


--
-- Name: admin_secondary_fee_attribution_rows(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_secondary_fee_attribution_rows() RETURNS TABLE(id uuid, amount numeric, source_type text, created_at timestamp with time zone, payer_id uuid, asset_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select f.id, f.amount, f.source_type, f.created_at, f.payer_id, f.asset_id
  from public.platform_fee_ledger f
  where f.source_type = 'p2p_fee'
  order by f.created_at desc;
end;
$$;


--
-- Name: FUNCTION admin_secondary_fee_attribution_rows(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_secondary_fee_attribution_rows() IS 'Admin-only read of secondary revenue fees with payer and asset attribution for team revenue reporting.';


--
-- Name: admin_secondary_fee_rows(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_secondary_fee_rows() RETURNS TABLE(id uuid, amount numeric, source_type text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select f.id, f.amount, f.source_type, f.created_at
  from public.platform_fee_ledger f
  where f.source_type = 'p2p_fee'
  order by f.created_at desc;
end;
$$;


--
-- Name: admin_set_announcement_active(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_announcement_active(announcement_id uuid, active boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare u_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; update public.platform_announcements set is_active=active,updated_at=now() where id=announcement_id; select email into u_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(u_email,''),'announcement.status','announcement',announcement_id::text,jsonb_build_object('active',active)); end $$;


--
-- Name: platform_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_config (
    id boolean DEFAULT true NOT NULL,
    featured_asset_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    safe_treasury_address text,
    jc_price numeric DEFAULT 1 NOT NULL,
    jc_redeem_price numeric DEFAULT 1 NOT NULL,
    rwmt_town_config jsonb DEFAULT '{"night": true, "theme": "modern", "house_gap": 3.2, "house_count": 10000}'::jsonb NOT NULL,
    maintenance_mode boolean DEFAULT false NOT NULL,
    maintenance_reason text,
    maintenance_updated_at timestamp with time zone,
    p2p_fee_bps integer DEFAULT 100 NOT NULL,
    p2p_listing_fee numeric DEFAULT 1 NOT NULL,
    p2p_fees_updated_at timestamp with time zone,
    active_safe_address text,
    active_safe_updated_at timestamp with time zone,
    CONSTRAINT platform_config_active_safe_address_check CHECK (((active_safe_address IS NULL) OR (active_safe_address ~ '^0x[0-9a-fA-F]{40}$'::text))),
    CONSTRAINT platform_config_id_check CHECK (id),
    CONSTRAINT platform_config_p2p_fee_bps_check CHECK (((p2p_fee_bps >= 0) AND (p2p_fee_bps <= 500))),
    CONSTRAINT platform_config_p2p_listing_fee_check CHECK (((p2p_listing_fee >= (0)::numeric) AND (p2p_listing_fee <= (10)::numeric) AND (p2p_listing_fee = round(p2p_listing_fee, 6))))
);


--
-- Name: admin_set_featured_asset(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_featured_asset(asset_key text) RETURNS public.platform_config
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.platform_config; u_email text;
begin
 if not private.is_admin() then raise exception 'not authorized'; end if;
 if asset_key is not null and not exists(select 1 from public.private_placements where id=asset_key) then raise exception 'asset not found'; end if;
 insert into public.platform_config(id,featured_asset_id,updated_at,updated_by) values(true,asset_key,now(),auth.uid()) on conflict(id) do update set featured_asset_id=excluded.featured_asset_id,updated_at=now(),updated_by=auth.uid() returning * into r;
 select email into u_email from public.profiles where id=auth.uid();
 insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(u_email,''),'featured_asset.update','platform_config',coalesce(asset_key,'none'),jsonb_build_object('featured_asset_id',asset_key));
 return r;
end $$;


--
-- Name: admin_set_jc_price(numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_jc_price(new_price numeric) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  u_email text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  if new_price is null or new_price <= 0 or new_price > 1000000 then
    raise exception 'invalid price';
  end if;

  update public.platform_config
  set jc_price = round(new_price, 6),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true;

  if not found then
    raise exception 'platform config row is missing';
  end if;

  select email into u_email
  from public.profiles
  where id = auth.uid();

  insert into public.admin_audit_logs(
    admin_id,
    admin_email,
    action,
    target_type,
    target_id,
    details
  )
  values (
    auth.uid(),
    coalesce(u_email, ''),
    'jc.price.update',
    'platform_config',
    'jc',
    jsonb_build_object('new_price', round(new_price, 6))
  );

  return round(new_price, 6);
end
$$;


--
-- Name: admin_set_jc_redeem_price(numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_jc_redeem_price(new_price numeric) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  u_email text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  if new_price is null or new_price <= 0 or new_price > 1000000 then
    raise exception 'invalid price';
  end if;

  update public.platform_config
  set jc_redeem_price = round(new_price, 6),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true;

  if not found then
    raise exception 'platform config row is missing';
  end if;

  select email into u_email
  from public.profiles
  where id = auth.uid();

  insert into public.admin_audit_logs(
    admin_id,
    admin_email,
    action,
    target_type,
    target_id,
    details
  )
  values (
    auth.uid(),
    coalesce(u_email, ''),
    'jc.redeem.price.update',
    'platform_config',
    'jc_redeem',
    jsonb_build_object('new_price', round(new_price, 6))
  );

  return round(new_price, 6);
end
$$;


--
-- Name: admin_set_maintenance_mode(boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_maintenance_mode(p_enabled boolean, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_email text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_reason is null or length(v_reason) < 2 then raise exception 'reason required'; end if;
  update public.platform_config
  set maintenance_mode = p_enabled,
      maintenance_reason = case when p_enabled then v_reason else null end,
      maintenance_updated_at = now(), updated_at = now(), updated_by = auth.uid()
  where id = true;
  select email into v_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(v_email, ''), case when p_enabled then 'maintenance.enable' else 'maintenance.disable' end,
          'platform_config', 'maintenance_mode', jsonb_build_object('reason', v_reason, 'enabled', p_enabled));
  return jsonb_build_object('maintenance_mode', p_enabled, 'reason', v_reason);
end;
$$;


--
-- Name: admin_set_placement_factory_params(text, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_placement_factory_params(p_id text, p_token_name text, p_token_symbol text, p_token_decimals integer) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
    declare result public.private_placements;
    begin
      if not private.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
      if p_token_decimals is not null and (p_token_decimals < 0 or p_token_decimals > 36) then
        raise exception 'invalid values';
      end if;
      update public.private_placements set
        token_name = nullif(trim(coalesce(p_token_name,'')),''),
        token_symbol = nullif(trim(coalesce(p_token_symbol,'')),''),
        token_decimals = p_token_decimals,
        updated_at = now()
      where id = trim(p_id)
      returning * into result;
      if result.id is null then raise exception 'not found'; end if;
      return result;
    end;$$;


--
-- Name: admin_set_placement_token_address(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_placement_token_address(p_id text, p_token_address text) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
    declare result public.private_placements;
    begin
      if not private.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
      if p_token_address is not null and p_token_address !~ '^0x[0-9a-fA-F]{40}$' then raise exception 'invalid token address'; end if;
      update public.private_placements set token_address = p_token_address, updated_at = now()
        where id = trim(p_id) returning * into result;
      if result.id is null then raise exception 'not found'; end if;
      return result;
    end;$_$;


--
-- Name: admin_set_rwa_ae_settings(text, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_rwa_ae_settings(placement_id text, p_total_value numeric, p_total_shares numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  a public.private_placements;
  ae_price numeric;
  sold numeric;
  per_share numeric;
  new_shares numeric;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if p_total_value is null or p_total_value <= 0 then raise exception 'invalid total value'; end if;
  if p_total_shares is null or p_total_shares <= 0 or p_total_shares <> trunc(p_total_shares) then raise exception 'invalid total shares'; end if;
  select * into a from public.private_placements where id=placement_id for update;
  if not found then raise exception 'placement not found'; end if;
  if a.is_ae_token then raise exception 'ae token cannot be an ae-settled rwa'; end if;
  ae_price := private.current_ae_price();
  if ae_price is null or ae_price <= 0 then raise exception 'ae price unavailable'; end if;
  -- 保留已售份額，避免調整時把已認購的份額洗掉
  sold := greatest(coalesce(a.total_supply,0) - coalesce(a.available,0), 0);
  new_shares := greatest(p_total_shares, sold);
  per_share := round(p_total_value / (p_total_shares * ae_price), 6);
  if per_share <= 0 then raise exception 'derived ae per share too small'; end if;
  update public.private_placements
    set settlement_currency='ae',
        rwa_total_value=p_total_value,
        total_supply=new_shares,
        available=new_shares - sold,
        ae_per_share=per_share,
        ae_per_share_price_ref=ae_price,
        price=round(p_total_value / new_shares, 6),  -- 每份 USDT 名目價（供二級市場等既有邏輯參考）
        updated_at=now()
    where id=placement_id;
  return jsonb_build_object('ok',true,'ae_per_share',per_share,'total_shares',new_shares,'ae_price_ref',ae_price);
end
$$;


--
-- Name: admin_set_rwmt_town_config(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_rwmt_town_config(p_config jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare clean jsonb; u_email text;
begin
if not private.is_admin() then raise exception 'not authorized'; end if;
if jsonb_typeof(p_config) <> 'object' then raise exception 'invalid config'; end if;
clean := jsonb_build_object('theme',case when p_config->>'theme' in ('modern','cyber','medieval','steam') then p_config->>'theme' else 'modern' end,'night',coalesce((p_config->>'night')::boolean,true),'house_count',least(200,greatest(18,coalesce((p_config->>'house_count')::int,48))),'house_gap',least(6,greatest(2.2,coalesce((p_config->>'house_gap')::numeric,3.2))));
update public.platform_config set rwmt_town_config=clean,updated_at=now(),updated_by=auth.uid() where id=true;
if not found then raise exception 'platform config row is missing'; end if;
select email into u_email from public.profiles where id=auth.uid();
insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(u_email,''),'rwmt.town.config.update','platform_config','rwmt_town',clean);
return clean;
end
$$;


--
-- Name: admin_set_user_role(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_user_role(target_user_id uuid, role_text text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare u_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if role_text not in ('總代理','代理','一般用戶','管理員') then raise exception 'invalid role'; end if; update public.profiles set agency_role=role_text,role_approved_at=case when role_text in ('總代理','代理') then now() else null end,updated_at=now() where id=target_user_id; if not found then raise exception 'user not found'; end if; update auth.users set raw_app_meta_data=coalesce(raw_app_meta_data,'{}'::jsonb)||jsonb_build_object('is_admin',role_text='管理員') where id=target_user_id; select email into u_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(u_email,''),'user.role.update','user',target_user_id::text,jsonb_build_object('role',role_text)); end $$;


--
-- Name: admin_settle_rwa_placement(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_settle_rwa_placement(asset_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare res jsonb; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  res := private.settle_rwa_placement(asset_key);
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
    values(auth.uid(),coalesce(u_email,''),'rwa.settle','private_placement',asset_key,res);
  return res;
end
$$;


--
-- Name: admin_start_ae_token_bonus_round(numeric, numeric, integer, numeric, text, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text DEFAULT 'AE 代幣獎勵'::text, p_information text DEFAULT ''::text, p_image text DEFAULT '/images/ae-token.png'::text, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  admin_email text;
  new_id text;
  outstanding_id text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  if p_price is null or p_price<=0 then raise exception 'invalid price'; end if;
  if p_total_supply is null or p_total_supply<=0 then raise exception 'invalid total supply'; end if;
  if p_release_interval_seconds is null or p_release_interval_seconds<=0 then raise exception 'invalid release interval'; end if;
  if p_release_amount_per_interval is null or p_release_amount_per_interval<=0 then raise exception 'invalid release amount'; end if;
  if trim(coalesce(p_name,''))='' then raise exception 'name required'; end if;

  select id into outstanding_id
  from public.private_placements
  where is_ae_token=true and ae_token_kind='bonus' and is_active=true and available>0
  limit 1;
  if outstanding_id is not null then
    raise exception '獎勵機制尚有未售完的庫存（%），請先等待售完或手動結束才能開啟新一輪', outstanding_id;
  end if;

  update public.private_placements
  set is_active=false, updated_at=now()
  where is_ae_token=true and ae_token_kind='bonus' and is_active=true;

  update public.private_placements
  set is_active=false, updated_at=now()
  where id='ae-token-daily';

  new_id := 'ae-token-bonus-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint;

  insert into public.private_placements(
    id,name,location,address,image,images,price,valuation,total_supply,available,apy,
    information,translations,ends_at,is_active,market_started_at,price_locked_until,
    history,comparables,advantages,
    is_ae_token,ae_token_kind,release_interval_seconds,release_amount_per_interval,release_started_at
  ) values (
    new_id, trim(p_name), 'AE 代幣', 'AE 代幣', p_image, array[p_image], p_price,
    p_price*p_total_supply, p_total_supply, p_total_supply, '',
    coalesce(p_information,''), '{}'::jsonb, coalesce(p_ends_at,'infinity'::timestamptz), true, now(), null,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    true, 'bonus', p_release_interval_seconds, p_release_amount_per_interval, now()
  ) returning * into result;

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,'create','ae_token_bonus_round',result.id,
    jsonb_build_object(
      'price',result.price,'total_supply',result.total_supply,
      'release_interval_seconds',result.release_interval_seconds,
      'release_amount_per_interval',result.release_amount_per_interval
    ));

  return result;
end;
$$;


--
-- Name: admin_start_ae_token_bonus_round(numeric, numeric, integer, numeric, text, text, text, timestamp with time zone, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text DEFAULT 'AE 代幣獎勵'::text, p_information text DEFAULT ''::text, p_image text DEFAULT '/images/ae-token.png'::text, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_bonus_normal_price numeric DEFAULT NULL::numeric) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare result public.private_placements; admin_email text; new_id text; outstanding_id text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if p_price is null or p_price<=0 then raise exception 'invalid price'; end if; if p_bonus_normal_price is null or p_bonus_normal_price<=0 then raise exception '獎勵結束後平常日價格必填且須大於 0'; end if; if p_total_supply is null or p_total_supply<=0 then raise exception 'invalid total supply'; end if; if p_release_interval_seconds is null or p_release_interval_seconds<=0 then raise exception 'invalid release interval'; end if; if p_release_amount_per_interval is null or p_release_amount_per_interval<=0 then raise exception 'invalid release amount'; end if; if trim(coalesce(p_name,''))='' then raise exception 'name required'; end if; select id into outstanding_id from public.private_placements where is_ae_token=true and ae_token_kind='bonus' and is_active=true and available>0 limit 1; if outstanding_id is not null then raise exception '獎勵機制尚有未售完的庫存（%），請先等待售完或手動結束才能開啟新一輪', outstanding_id; end if; update public.private_placements set is_active=false,updated_at=now() where is_ae_token=true and ae_token_kind='bonus' and is_active=true; update public.private_placements set is_active=false,updated_at=now() where id='ae-token-daily'; new_id:='ae-token-bonus-'||floor(extract(epoch from clock_timestamp())*1000)::bigint; insert into public.private_placements(id,name,location,address,image,images,price,valuation,total_supply,available,apy,information,translations,ends_at,is_active,market_started_at,price_locked_until,history,comparables,advantages,is_ae_token,ae_token_kind,release_interval_seconds,release_amount_per_interval,release_started_at,bonus_normal_price) values(new_id,trim(p_name),'AE 代幣','AE 代幣',p_image,array[p_image],p_price,p_price*p_total_supply,p_total_supply,p_total_supply,'',coalesce(p_information,''),'{}'::jsonb,coalesce(p_ends_at,'infinity'::timestamptz),true,now(),null,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,true,'bonus',p_release_interval_seconds,p_release_amount_per_interval,now(),p_bonus_normal_price) returning * into result; select email into admin_email from auth.users where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),admin_email,'create','ae_token_bonus_round',result.id,jsonb_build_object('price',result.price,'bonus_normal_price',result.bonus_normal_price,'total_supply',result.total_supply,'release_interval_seconds',result.release_interval_seconds,'release_amount_per_interval',result.release_amount_per_interval)); return result; end; $$;


--
-- Name: admin_start_rwmt_town_round(text, boolean, integer, integer, integer, numeric, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare active_id bigint; next_no int; new_round public.rwmt_town_rounds; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if p_theme not in ('modern','cyber','medieval','steam') then raise exception 'invalid theme'; end if;
  if p_house_count < 18 or p_house_count > 10000 then raise exception 'house count must be 18-10000'; end if;
  if p_ae_total < 1 or p_ae_total > p_house_count then raise exception 'invalid ae total'; end if;
  if p_bomb_total < 0 or p_bomb_total + p_ae_total > p_house_count then raise exception 'invalid bomb total'; end if;
  if p_bomb_jc < 0 then raise exception 'invalid bomb jc'; end if;

  select id into active_id from public.rwmt_town_rounds where status = 'active' limit 1 for update;
  if active_id is not null then
    if not p_force then raise exception 'previous round still active'; end if;
    update public.rwmt_town_rounds set status = 'ended', ended_at = now() where id = active_id;
  end if;

  select coalesce(max(round_no), 0) + 1 into next_no from public.rwmt_town_rounds;
  insert into public.rwmt_town_rounds (round_no, theme, night, house_count, ae_total, ae_remaining, bomb_total, bomb_remaining, bomb_jc, seed, created_by)
  values (next_no, p_theme, p_night, p_house_count, p_ae_total, p_ae_total, p_bomb_total, p_bomb_total, p_bomb_jc,
          (random() * 9e15)::bigint, auth.uid())
  returning * into new_round;

  update public.platform_config set rwmt_town_config = coalesce(rwmt_town_config, '{}'::jsonb)
    || jsonb_build_object('theme', p_theme, 'night', p_night, 'house_count', p_house_count), updated_at = now(), updated_by = auth.uid()
    where id = true;

  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs (admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, ''), 'rwmt.town.round.start', 'rwmt_town_round', new_round.id::text,
          jsonb_build_object('round_no', next_no, 'theme', p_theme, 'house_count', p_house_count, 'ae_total', p_ae_total,
                             'bomb_total', p_bomb_total, 'bomb_jc', p_bomb_jc, 'forced', active_id is not null));
  return jsonb_build_object('id', new_round.id, 'round_no', next_no);
end
$$;


--
-- Name: admin_sync_jc_chain_balance(uuid, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  ledger_balance numeric;
  adjustment numeric;
  sync_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少使用者 ID';
  END IF;
  IF p_wallet IS NULL OR p_wallet !~* '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION '錢包地址格式錯誤';
  END IF;
  IF p_chain_balance IS NULL OR p_chain_balance < 0 OR p_chain_balance > 1000000000000000000 THEN
    RAISE EXCEPTION '鏈上 JC 餘額無效';
  END IF;

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到使用者帳號';
  END IF;

  SELECT COALESCE(
    SUM(l.amount) FILTER (WHERE l.entry_type <> 'commission_pending'),
    0
  )
  INTO ledger_balance
  FROM public.jc_ledger AS l
  WHERE l.user_id = p_user_id;

  adjustment := p_chain_balance - ledger_balance;
  IF adjustment = 0 THEN
    RETURN jsonb_build_object(
      'balance', ledger_balance,
      'adjustment', 0
    );
  END IF;

  sync_key := 'onchain-balance-sync:' || p_user_id::text || ':' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.jc_ledger (
    user_id,
    entry_type,
    amount,
    idempotency_key,
    metadata
  ) VALUES (
    p_user_id,
    'onchain_balance_sync',
    adjustment,
    sync_key,
    jsonb_build_object(
      'source', 'current_jc_contract',
      'contract', '0xE035d5A79664843089F9Ee9F8dA2980cfB5eE4D9',
      'wallet', lower(p_wallet),
      'chain_balance', p_chain_balance,
      'ledger_before', ledger_balance
    )
  );

  RETURN jsonb_build_object(
    'balance', p_chain_balance,
    'adjustment', adjustment
  );
END;
$_$;


--
-- Name: FUNCTION admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric) IS 'Service-role only: reconcile JC ledger to the authenticated user wallet balance on the current JC contract. Legacy contract balances are offset, not deleted.';


--
-- Name: admin_update_commission_rate(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_commission_rate(role_text text, rate_percent numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare u_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if role_text not in ('總代理','代理') or rate_percent<0 or rate_percent>100 then raise exception 'invalid setting'; end if; insert into public.commission_settings(agency_role,rate,updated_by,updated_at) values(role_text,rate_percent/100,auth.uid(),now()) on conflict(agency_role) do update set rate=excluded.rate,updated_by=excluded.updated_by,updated_at=excluded.updated_at; select email into u_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(u_email,''),'commission.rate.update','commission_setting',role_text,jsonb_build_object('rate_percent',rate_percent)); end $$;


--
-- Name: admin_update_commission_rates(text, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_commission_rates(role_text text, private_percent numeric, secondary_percent numeric, asset_mode_text text DEFAULT 'ae_coin'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if role_text not in ('總代理','代理','總代理直屬')
     or private_percent is null or secondary_percent is null
     or private_percent < 0 or private_percent > 100
     or secondary_percent < 0 or secondary_percent > 100
     or asset_mode_text not in ('ae_coin','rwa') then
    raise exception 'invalid setting';
  end if;

  insert into public.commission_settings(
    agency_role, rate, private_rate, secondary_rate, asset_mode, updated_by, updated_at
  ) values (
    role_text, private_percent / 100, private_percent / 100,
    secondary_percent / 100, asset_mode_text, auth.uid(), now()
  ) on conflict (agency_role, asset_mode) do update set
    rate = excluded.rate,
    private_rate = excluded.private_rate,
    secondary_rate = excluded.secondary_rate,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),coalesce(u_email,''),'commission.rates.update','commission_setting',role_text,
    jsonb_build_object(
      'private_percent',private_percent,
      'secondary_percent',secondary_percent,
      'private_rate',private_percent / 100,
      'secondary_rate',secondary_percent / 100,
      'asset_mode',asset_mode_text
    ));
end
$$;


--
-- Name: admin_update_placement_apy(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_placement_apy(placement_id text, new_apy text) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare result public.private_placements; admin_email text; old_apy text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if trim(coalesce(placement_id,''))='' or char_length(trim(coalesce(new_apy,'')))>80 then raise exception 'invalid values'; end if; select apy into old_apy from public.private_placements where id=placement_id; if not found then raise exception 'placement not found'; end if; update public.private_placements set apy=trim(coalesce(new_apy,'')),updated_at=now() where id=placement_id returning * into result; select email into admin_email from public.profiles where id=auth.uid(); insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),coalesce(admin_email,''),'update_placement_apy','private_placement',placement_id,jsonb_build_object('old_apy',old_apy,'new_apy',result.apy)); return result; end $$;


--
-- Name: admin_update_placement_translations(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_placement_translations(p_id text, p_translations jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare admin_email text; begin if auth.uid() is null or not private.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if; if p_id is null or trim(p_id) = '' or jsonb_typeof(p_translations) <> 'object' then raise exception 'invalid translation payload' using errcode = '22023'; end if; update public.private_placements set translations = p_translations, updated_at = now() where id = p_id; if not found then raise exception 'placement not found' using errcode = 'P0002'; end if; select email into admin_email from auth.users where id = auth.uid(); insert into public.admin_audit_logs (admin_id, admin_email, action, target_type, target_id, details) values (auth.uid(), admin_email, 'translate', 'private_placement', p_id, jsonb_build_object('languages', (select count(*) from jsonb_object_keys(p_translations)))); end; $$;


--
-- Name: admin_update_profile(uuid, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_profile(target_id uuid, new_balance numeric DEFAULT NULL::numeric, new_agency_role text DEFAULT NULL::text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare result public.profiles;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if new_balance is not null and new_balance < 0 then raise exception 'invalid balance'; end if;
  if new_agency_role is not null and new_agency_role not in ('一般用戶','二代代理','一代代理','總代理','admin') then raise exception 'invalid agency role'; end if;
  update public.profiles
  set balance=coalesce(new_balance,balance),agency_role=coalesce(new_agency_role,agency_role),updated_at=now()
  where id=target_id returning * into result;
  return result;
end;
$$;


--
-- Name: site_visual_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_visual_effects (
    id boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    effect text DEFAULT 'fireworks'::text NOT NULL,
    color text DEFAULT '#38bdf8'::text NOT NULL,
    intensity numeric DEFAULT 0.65 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_visual_effects_effect_check CHECK ((effect = ANY (ARRAY['fireworks'::text, 'sparkles'::text, 'none'::text]))),
    CONSTRAINT site_visual_effects_id_check CHECK (id),
    CONSTRAINT site_visual_effects_intensity_check CHECK (((intensity >= (0)::numeric) AND (intensity <= (1)::numeric)))
);


--
-- Name: admin_update_site_visual_effects(boolean, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric) RETURNS public.site_visual_effects
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$ declare row public.site_visual_effects; begin if not exists (select 1 from public.profiles where id=auth.uid() and (agency_role in ('管理員','admin') or role='admin')) then raise exception 'admin only' using errcode='42501'; end if; update public.site_visual_effects set enabled=p_enabled,effect=case when p_effect in ('fireworks','sparkles','none') then p_effect else 'fireworks' end,color=case when p_color ~ '^#[0-9A-Fa-f]{6}$' then p_color else '#38bdf8' end,intensity=greatest(0,least(1,p_intensity)),updated_at=now() where id=true returning * into row; return row; end $_$;


--
-- Name: admin_update_user_commission(uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_update_user_commission(target_user_id uuid, new_self_private_rate numeric, new_l1_private_rate numeric, new_l2_private_rate numeric, new_secondary_rate numeric, new_self_secondary_rate numeric, new_l1_secondary_rate numeric, new_l2_secondary_rate numeric, asset_mode_text text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ begin if not private.is_admin() then raise exception 'not authorized'; end if; if new_self_private_rate is null and new_l1_private_rate is null and new_l2_private_rate is null and new_secondary_rate is null and new_self_secondary_rate is null and new_l1_secondary_rate is null and new_l2_secondary_rate is null then delete from public.commission_user_overrides where user_id=target_user_id and asset_mode=asset_mode_text; else insert into public.commission_user_overrides(user_id,private_rate,secondary_rate,self_private_rate,l1_private_rate,l2_private_rate,self_secondary_rate,l1_secondary_rate,l2_secondary_rate,asset_mode,updated_at,updated_by) values(target_user_id,new_l1_private_rate,new_l1_secondary_rate,new_self_private_rate,new_l1_private_rate,new_l2_private_rate,new_self_secondary_rate,new_l1_secondary_rate,new_l2_secondary_rate,asset_mode_text,now(),auth.uid()) on conflict(user_id,asset_mode) do update set private_rate=excluded.private_rate,secondary_rate=excluded.secondary_rate,self_private_rate=excluded.self_private_rate,l1_private_rate=excluded.l1_private_rate,l2_private_rate=excluded.l2_private_rate,self_secondary_rate=excluded.self_secondary_rate,l1_secondary_rate=excluded.l1_secondary_rate,l2_secondary_rate=excluded.l2_secondary_rate,updated_at=now(),updated_by=auth.uid(); end if; end; $$;


--
-- Name: admin_upsert_placement(text, text, text, text, text[], numeric, numeric, numeric, numeric, text, text, jsonb, timestamp with time zone, jsonb, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_upsert_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) RETURNS public.private_placements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.private_placements;
  previous public.private_placements;
  admin_email text;
  changed_fields jsonb := '{}'::jsonb;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if trim(p_id)='' or trim(p_name)='' or trim(p_location)='' or trim(p_address)=''
    or cardinality(p_images)=0 or p_price<=0 or p_valuation<=0 or p_total_supply<=0
    or p_available<0 or p_available>p_total_supply
    or char_length(trim(coalesce(p_apy,'')))>80
    or exists(select 1 from unnest(p_images) u where u !~ '^https://')
    or jsonb_typeof(coalesce(p_history,'[]')) <> 'array'
    or jsonb_typeof(coalesce(p_comparables,'[]')) <> 'array'
    or jsonb_typeof(coalesce(p_advantages,'[]')) <> 'array'
  then raise exception 'invalid values'; end if;

  select * into previous from public.private_placements where id=p_id for update;
  if previous.id is null then raise exception 'placement not found'; end if;
  if previous.valuation is distinct from p_valuation then
    changed_fields := changed_fields || jsonb_build_object('valuation',jsonb_build_object('from',previous.valuation,'to',p_valuation));
  end if;
  if previous.price is distinct from p_price then
    changed_fields := changed_fields || jsonb_build_object('price',jsonb_build_object('from',previous.price,'to',p_price));
  end if;

  update public.private_placements set
    name=trim(p_name), location=trim(p_location), address=trim(p_address), image=p_images[1], images=p_images,
    price=p_price, valuation=p_valuation, total_supply=p_total_supply, available=p_available,
    apy=trim(coalesce(p_apy,'')), information=coalesce(p_information,''), translations=p_translations,
    ends_at=p_ends_at, history=coalesce(p_history,'[]'), comparables=coalesce(p_comparables,'[]'),
    advantages=coalesce(p_advantages,'[]'), updated_at=now()
  where id=p_id returning * into result;

  if previous.price is distinct from p_price then
    insert into public.market_price_snapshots(asset_id, price, recorded_by)
    values(result.id, p_price, auth.uid());
  end if;

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,'update','private_placement',result.id,
    jsonb_build_object('name',result.name,'changed_fields',changed_fields));
  return result;
end;
$$;


--
-- Name: bind_referral_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bind_referral_code(promo text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  me public.profiles;
  sponsor public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  perform set_config('app.allow_referral_bind', 'on', true);

  select * into me from public.profiles where id = auth.uid() for update;
  if me.parent_id is not null or me.referrer_id is not null then
    raise exception 'referral already bound';
  end if;

  select * into sponsor from public.profiles
  where upper(promo_code) = upper(trim(promo))
    and id <> auth.uid()
  limit 1;
  if not found then raise exception 'invalid referral code'; end if;

  update public.profiles
  set parent_id = sponsor.id,
      referrer_id = sponsor.id,
      master_agent_id = sponsor.master_agent_id
  where id = auth.uid()
  returning * into me;

  insert into public.referral_binding_logs(user_id,new_referrer_id,new_master_agent_id,action,reason,actor_id)
  values (me.id, me.referrer_id, me.master_agent_id, 'initial_bind', '會員首次綁定', auth.uid());
  return me;
end;
$$;


--
-- Name: cancel_p2p_order(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_p2p_order(order_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$declare r public.p2p_orders; begin if auth.uid() is null then raise exception 'not authenticated'; end if; update public.p2p_orders set status='cancelled',updated_at=now() where id=order_key and user_id=auth.uid() and status in('open','partially_filled') returning * into r; if not found then raise exception 'order unavailable'; end if; return jsonb_build_object('id',r.id,'status',r.status); end$$;


--
-- Name: claim_sweep_slot(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_sweep_slot(p_key text, p_min_interval_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  claimed boolean := false;
begin
  insert into automation_state (key, last_run_at)
  values (p_key, now())
  on conflict (key) do update
    set last_run_at = now()
    where automation_state.last_run_at < now() - make_interval(secs => p_min_interval_seconds)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;


--
-- Name: complete_telegram_account_link(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_telegram_account_link(p_token_hash text, p_chat_id text, p_telegram_username text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_user_id uuid;
  v_previous_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Telegram link token';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'Invalid Telegram chat id';
  end if;
  if p_telegram_username is not null and p_telegram_username !~ '^[A-Za-z0-9_]{5,32}$' then
    raise exception 'Invalid Telegram username';
  end if;

  select token.user_id
    into v_user_id
    from public.telegram_link_tokens as token
   where token.token_hash = p_token_hash
     and token.used_at is null
     and token.expires_at > v_now
   for update;

  if v_user_id is null then
    return null;
  end if;

  update public.telegram_link_tokens
     set used_at = v_now
   where token_hash = p_token_hash;

  select link.user_id
    into v_previous_user_id
    from public.telegram_user_links as link
   where link.chat_id = p_chat_id
   for update;

  delete from public.telegram_user_links
   where chat_id = p_chat_id
     and user_id <> v_user_id;

  insert into public.telegram_user_links (user_id, chat_id, telegram_username, linked_at)
  values (v_user_id, p_chat_id, p_telegram_username, v_now)
  on conflict (user_id) do update
    set chat_id = excluded.chat_id,
        telegram_username = excluded.telegram_username,
        linked_at = excluded.linked_at;

  return jsonb_build_object(
    'user_id', v_user_id,
    'replaced_existing', v_previous_user_id is not null and v_previous_user_id <> v_user_id
  );
end;
$_$;


--
-- Name: confirm_p2p_escrow_order(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_p2p_escrow_order(p_user_id uuid, p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
end $_$;


--
-- Name: create_p2p_order(text, text, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_p2p_order(asset_key text, order_side text, order_price numeric, order_quantity numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
end $$;


--
-- Name: execute_private_purchase(text, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  select * into a from public.private_placements where id = asset_key for update;
  if not found or a.is_delisted or not a.is_active or (a.market_started_at is not null and not a.is_ae_token) or clock_timestamp() >= a.ends_at then raise exception 'asset unavailable'; end if;
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
$$;


--
-- Name: FUNCTION execute_private_purchase(asset_key text, trade_quantity numeric, request_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text) IS 'Creates a private-purchase reservation; formal ledger, holdings, and inventory changes happen only after chain settlement.';


--
-- Name: asset_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    entry_type text NOT NULL,
    amount numeric(20,6) NOT NULL,
    asset_id text,
    quantity numeric(20,4),
    idempotency_key text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_ledger_amount_check CHECK (((amount <> (0)::numeric) OR (entry_type = ANY (ARRAY['private_purchase'::text, 'p2p_buy'::text])))),
    CONSTRAINT asset_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['sandbox_deposit'::text, 'private_purchase'::text, 'secondary_buy'::text, 'secondary_sell'::text, 'p2p_buy'::text, 'p2p_sell'::text, 'p2p_gas'::text, 'commission'::text, 'commission_pending'::text, 'commission_payout'::text, 'vault_buy_jc'::text, 'vault_redeem_jc'::text])))
);


--
-- Name: execute_sandbox_trade(text, text, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.execute_sandbox_trade(asset_key text, trade_side text, trade_quantity numeric, request_key text) RETURNS public.asset_ledger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  a public.private_placements;
  owned numeric := 0;
  bal numeric;
  gross numeric;
  fee numeric := 0;
  delta numeric;
  new_available numeric;
  typ text;
  commission_kind text;
  result public.asset_ledger;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if request_key is null or length(trim(request_key)) < 8 then raise exception 'invalid request key'; end if;
  if trade_quantity is null or trade_quantity <= 0 or trade_quantity > 1000000 or trade_quantity <> trunc(trade_quantity) then
    raise exception 'invalid quantity';
  end if;

  select * into result from public.asset_ledger where idempotency_key = request_key and user_id = auth.uid();
  if found then return result; end if;

  select * into a from public.private_placements where id = asset_key for update;
  if not found or a.is_delisted then raise exception 'asset unavailable'; end if;

  gross := round(trade_quantity * a.price, 6);
  select coalesce(sum(amount), 0) into bal from public.asset_ledger where user_id = auth.uid() and entry_type <> 'commission_pending';
  select coalesce((select quantity from public.holdings where user_id = auth.uid() and asset_id = asset_key), 0) into owned;

  if trade_side = 'private_buy' then
    if not a.is_active or a.market_started_at is not null or a.available <= 0 then raise exception 'asset unavailable'; end if;
    if clock_timestamp() > a.ends_at then raise exception 'placement ended'; end if;
    if trade_quantity > a.available then raise exception 'insufficient supply'; end if;
    if gross > bal then raise exception 'insufficient balance'; end if;
    delta := -gross; typ := 'private_purchase'; commission_kind := 'private';
    new_available := a.available - trade_quantity;
    update public.private_placements
    set available = new_available,
        is_active = case when new_available = 0 then false else is_active end,
        ends_at = case when new_available = 0 then least(ends_at, now()) else ends_at end,
        market_started_at = case when new_available = 0 then now() else market_started_at end,
        updated_at = now()
    where id = asset_key;
  elsif trade_side = 'secondary_buy' then
    if a.market_started_at is null then raise exception 'secondary market unavailable'; end if;
    if gross > bal then raise exception 'insufficient balance'; end if;
    delta := -gross; typ := 'secondary_buy'; commission_kind := 'secondary';
  elsif trade_side = 'secondary_sell' then
    if a.market_started_at is null then raise exception 'secondary market unavailable'; end if;
    if trade_quantity > owned then raise exception 'insufficient holdings'; end if;
    fee := round(gross * .01 + 1, 6);
    if gross <= fee then raise exception 'trade too small'; end if;
    delta := gross - fee; typ := 'secondary_sell'; commission_kind := 'secondary';
  else
    raise exception 'invalid side';
  end if;

  insert into public.asset_ledger(user_id, entry_type, amount, asset_id, quantity, idempotency_key, metadata)
  values(auth.uid(), typ, delta, asset_key, trade_quantity, request_key, jsonb_build_object('gross', gross, 'fee', fee, 'commission_kind', commission_kind))
  returning * into result;

  if trade_side = 'secondary_sell' then
    update public.holdings set quantity = quantity - trade_quantity, updated_at = now() where user_id = auth.uid() and asset_id = asset_key;
  else
    insert into public.holdings(user_id, asset_id, quantity) values(auth.uid(), asset_key, trade_quantity)
    on conflict(user_id, asset_id) do update set quantity = public.holdings.quantity + excluded.quantity, updated_at = now();
  end if;

  begin
    perform private.post_referral_commissions(auth.uid(), asset_key, commission_kind, gross, result.id, request_key);
  exception when others then
    insert into public.commission_processing_errors(user_id, asset_id, transaction_type, gross, source_ledger_id, request_key, error_message)
    values(auth.uid(), asset_key, commission_kind, gross, result.id, request_key, sqlerrm)
    on conflict (request_key) do nothing;
  end;
  return result;
end
$$;


--
-- Name: fill_p2p_order(uuid, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_p2p_order(order_key uuid, fill_quantity numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: finalize_commission_payout(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_commission_payout(p_commission_id uuid, p_tx_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare c public.commission_logs; settlement public.onchain_settlements; payout_row public.jc_ledger;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_tx_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid payout transaction'; end if;
  select * into c from public.commission_logs where id = p_commission_id for update;
  if not found or c.beneficiary_id is null or c.commission_amount <= 0 then raise exception 'commission payout not found'; end if;
  select * into settlement from public.onchain_settlements where ref_key = 'commission:' || p_commission_id::text for update;
  if not found then raise exception 'commission settlement claim not found'; end if;
  if settlement.status = 'confirmed' and c.paid_at is not null then return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'tx_hash', settlement.tx_hash); end if;
  if settlement.action <> 'commission' then raise exception 'invalid commission settlement action'; end if;
  insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
    values(c.beneficiary_id, 'commission_payout', c.commission_amount, c.asset_id, 'commission-payout:' || c.id::text, jsonb_build_object('commission_log_id', c.id, 'onchain', true, 'tx', p_tx_hash))
    on conflict (idempotency_key) do nothing;
  select * into payout_row from public.jc_ledger where idempotency_key = 'commission-payout:' || c.id::text;
  if payout_row.id is null then raise exception 'commission ledger finalization failed'; end if;
  update public.commission_logs set paid_at = coalesce(paid_at, now()) where id = c.id;
  update public.onchain_settlements set status = 'confirmed', tx_hash = p_tx_hash, error = null, updated_at = now(), payload = payload || jsonb_build_object('payoutTx', p_tx_hash) where id = settlement.id;
  return jsonb_build_object('status', 'confirmed', 'tx_hash', p_tx_hash, 'amount', c.commission_amount);
end;
$_$;


--
-- Name: FUNCTION finalize_commission_payout(p_commission_id uuid, p_tx_hash text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.finalize_commission_payout(p_commission_id uuid, p_tx_hash text) IS 'Atomically records commission payout, paid timestamp, and settlement confirmation after a confirmed transfer.';


--
-- Name: finalize_jc_redemption(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_jc_redemption(p_order_id uuid, p_jc_collect_tx text, p_usdt_tx text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$ declare o public.redemption_orders; r public.settlement_reservations; ledger_row public.jc_ledger; v_request_key text; begin if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if; if p_jc_collect_tx !~ '^0x[0-9a-fA-F]{64}$' or p_usdt_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid chain transaction data'; end if; select * into o from public.redemption_orders where id = p_order_id for update; if not found then raise exception 'redemption order not found'; end if; v_request_key := o.idempotency_key; select * into r from public.settlement_reservations sr where sr.request_key = v_request_key for update; if not found or r.action <> 'redeem' or r.user_id <> o.user_id then raise exception 'redemption reservation not found'; end if; if o.status = 'completed' and r.status = 'confirmed' then return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'tx_hash', o.tx_hash, 'order_id', o.id); end if; if o.status <> 'pending' or r.status <> 'pending' then raise exception 'redemption is not pending'; end if; perform 1 from public.profiles where id = o.user_id for update; perform set_config('app.settlement_request_key', v_request_key, true); insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata) values(o.user_id, 'redemption_pending', -o.jc_amount, v_request_key || ':jc', jsonb_build_object('usdt', o.usdt_amount, 'jc_price', o.jc_price, 'jc_redeem_price', o.jc_price, 'jc_collect_tx', p_jc_collect_tx, 'usdt_tx', p_usdt_tx)) on conflict (idempotency_key) do nothing; select * into ledger_row from public.jc_ledger where idempotency_key = v_request_key || ':jc'; if ledger_row.id is null then raise exception 'redemption ledger finalization failed'; end if; update public.redemption_orders set status = 'completed', jc_ledger_id = ledger_row.id, tx_hash = p_usdt_tx, admin_note = '系統自動撥款（鏈上即時結算）', resolved_at = now(), updated_at = now() where id = o.id; update public.settlement_reservations set status = 'confirmed', settled_at = now(), updated_at = now(), chain_payload = chain_payload || jsonb_build_object('jc_collect_tx', p_jc_collect_tx, 'usdt_tx', p_usdt_tx) where settlement_reservations.request_key = v_request_key; return jsonb_build_object('status', 'confirmed', 'tx_hash', p_usdt_tx, 'jc_collect_tx', p_jc_collect_tx, 'jc_amount', o.jc_amount, 'usdt_amount', o.usdt_amount, 'order_id', o.id); end; $_$;


--
-- Name: finalize_p2p_escrow_auto_match(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_p2p_escrow_auto_match(p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  old_fill public.p2p_escrow_fills; b public.p2p_orders; event_order public.p2p_orders; buy_uuid uuid; v_fill_key text; v_tx_hash text; qty numeric; released numeric; result jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  v_fill_key:=lower(p_event->>'fillKey'); v_tx_hash:=lower(p_event->>'txHash'); qty:=(p_event->>'quantity')::numeric/1e18; released:=round((p_event->>'currencyReleased')::numeric/1e18,6);
  select * into old_fill from public.p2p_escrow_fills f where f.fill_key=v_fill_key;
  if found then
    if old_fill.tx_hash<>v_tx_hash or old_fill.counter_chain_order_id is distinct from (p_event->>'counterOrderId')::numeric then raise exception 'fill key already used by another transaction'; end if;
    return jsonb_build_object('status','confirmed','idempotent',true,'fill_key',v_fill_key);
  end if;
  buy_uuid:=private.validate_p2p_auto_match(p_event);
  if buy_uuid is null then raise exception 'automatic chain fill does not match both database orders'; end if;
  select * into b from public.p2p_orders where id=buy_uuid;
  select * into event_order from public.p2p_orders where escrow_chain_order_id=(p_event->>'orderId')::numeric and escrow_contract_address=private.escrow_event_contract(p_event) for update;
  if not found then raise exception 'automatic chain order is missing from database'; end if;
  result:=public.finalize_p2p_escrow_fill(p_event);
  if event_order.side='sell' then
    insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata) values(b.user_id,'p2p_order_release',released,b.asset_id,'escrow-fill:'||v_fill_key||':reserve-release',jsonb_build_object('order_id',b.id,'fill_key',v_fill_key,'reason','reserved JC converted to completed trade')) on conflict (idempotency_key) do nothing;
    update public.p2p_orders set remaining_quantity=greatest(remaining_quantity-qty,0),escrow_locked_currency=greatest(coalesce(escrow_locked_currency,0)-released,0),status=case when remaining_quantity-qty<=0 then 'filled' else 'partially_filled' end,updated_at=now() where id=b.id and status in ('open','partially_filled') and remaining_quantity>=qty;
  end if;
  update public.p2p_escrow_fills set counter_chain_order_id=(p_event->>'counterOrderId')::numeric,counter_order_id=b.id where fill_key=v_fill_key and tx_hash=v_tx_hash;
  return result || jsonb_build_object('buy_order_id',b.id,'automatic',true);
end
$$;


--
-- Name: finalize_p2p_escrow_cancel(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_p2p_escrow_cancel(p_user_id uuid, p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: finalize_p2p_escrow_fill(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_p2p_escrow_fill(p_event jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
    or round(v_price*v_quantity,6)<>v_gross then raise exception 'invalid escrow fill'; end if;

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
    or (o.side='buy' and o.price<v_price) or (o.side='sell' and o.price>v_price)
    or lower(o.escrow_token_address)<>lower(p_event->>'assetToken')
    or lower(o.escrow_currency_address)<>lower(p_event->>'currencyToken')
    or (o.side='buy' and v_currency_released<v_gross)
    or v_currency_released<0 then raise exception 'chain trade does not match database order'; end if;
  if round(v_gross*coalesce(o.fee_bps,100)/10000.0,6)<>v_fee then raise exception 'invalid escrow fill fee'; end if;

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
  update public.holdings
    set quantity = quantity - v_quantity, updated_at = now()
    where user_id = v_seller_id
      and asset_id = o.asset_id
      and quantity >= v_quantity;
  if not found then
    raise exception 'seller holdings are insufficient for escrow fill';
  end if;
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
$_$;


--
-- Name: finalize_private_purchase(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_private_purchase(p_request_key text, p_jc_pull_tx text, p_jc_vault_tx text, p_asset_tx text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare r public.settlement_reservations; a public.private_placements; ledger_row public.jc_ledger; new_available numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_request_key is null or p_jc_pull_tx !~ '^0x[0-9a-fA-F]{64}$' or p_jc_vault_tx !~ '^0x[0-9a-fA-F]{64}$' or p_asset_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid chain transaction data'; end if;
  select * into r from public.settlement_reservations where request_key = p_request_key for update;
  if not found or r.action <> 'subscribe' then raise exception 'subscription reservation not found'; end if;
  if r.status = 'confirmed' then select * into ledger_row from public.jc_ledger where idempotency_key = p_request_key; return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'ledger_id', ledger_row.id); end if;
  if r.status <> 'pending' then raise exception 'subscription reservation is not pending'; end if;
  perform 1 from public.profiles where id = r.user_id for update;
  select * into a from public.private_placements where id = r.asset_id for update;
  if not found then raise exception 'placement not found'; end if;
  if a.available < r.quantity then raise exception 'reserved placement inventory is no longer available'; end if;
  perform set_config('app.settlement_request_key', p_request_key, true);
  insert into public.jc_ledger(user_id, entry_type, amount, asset_id, quantity, idempotency_key, metadata)
    values(r.user_id, 'private_purchase', -r.jc_amount, r.asset_id, r.quantity, p_request_key,
      jsonb_build_object('gross', r.jc_amount, 'jc_price', r.chain_payload -> 'jc_price', 'jc_pull_tx', p_jc_pull_tx, 'jc_vault_tx', p_jc_vault_tx, 'asset_tx', p_asset_tx))
    on conflict (idempotency_key) do nothing;
  select * into ledger_row from public.jc_ledger where idempotency_key = p_request_key;
  if ledger_row.id is null then raise exception 'subscription ledger finalization failed'; end if;
  insert into public.holdings(user_id, asset_id, quantity, updated_at) values(r.user_id, r.asset_id, r.quantity, now())
    on conflict(user_id, asset_id) do update set quantity = public.holdings.quantity + excluded.quantity, updated_at = now();
  new_available := a.available - r.quantity;
  update public.private_placements set available = new_available, updated_at = now(), market_started_at = case when new_available = 0 then coalesce(market_started_at, now()) else market_started_at end where id = r.asset_id;
  if a.is_ae_token and a.ae_token_kind = 'bonus' and new_available = 0 then update public.private_placements set is_active = true, updated_at = now() where id = 'ae-token-daily'; end if;
  perform private.post_referral_commissions(r.user_id, r.asset_id, 'private', r.jc_amount, ledger_row.id, p_request_key || ':commission');
  update public.settlement_reservations set status = 'confirmed', settled_at = now(), updated_at = now(), chain_payload = chain_payload || jsonb_build_object('jc_pull_tx', p_jc_pull_tx, 'jc_vault_tx', p_jc_vault_tx, 'asset_tx', p_asset_tx) where request_key = p_request_key;
  return jsonb_build_object('status', 'confirmed', 'ledger_id', ledger_row.id, 'gross', r.jc_amount, 'quantity', r.quantity, 'entered_secondary_market', new_available = 0);
end;
$_$;


--
-- Name: finalize_vault_jc_purchase(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_vault_jc_purchase(p_request_key text, p_mint_tx text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare r public.settlement_reservations; usdt_row public.asset_ledger; jc_row public.jc_ledger;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_mint_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid mint transaction'; end if;
  select * into r from public.settlement_reservations where request_key = p_request_key for update;
  if not found or r.action <> 'vault_buy' then raise exception 'vault purchase reservation not found'; end if;
  if r.status = 'confirmed' then select * into jc_row from public.jc_ledger where idempotency_key = p_request_key || ':jc'; return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'tx_hash', p_mint_tx, 'ledger_id', jc_row.id); end if;
  if r.status <> 'pending' then raise exception 'vault purchase reservation is not pending'; end if;
  insert into public.asset_ledger(user_id, entry_type, amount, idempotency_key, metadata)
    values(r.user_id, 'vault_buy_jc', -r.usdt_amount, p_request_key || ':usdt', jsonb_build_object('jc_amount', r.jc_amount, 'jc_price', r.chain_payload -> 'jc_price', 'tx_hash', r.source_tx_hash, 'mint_tx', p_mint_tx, 'vault_address', public.get_safe_vault_address()))
    on conflict (idempotency_key) do nothing;
  select * into usdt_row from public.asset_ledger where idempotency_key = p_request_key || ':usdt';
  if usdt_row.id is null then raise exception 'USDT ledger finalization failed'; end if;
  insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata)
    values(r.user_id, 'vault_buy', r.jc_amount, p_request_key || ':jc', jsonb_build_object('usdt', r.usdt_amount, 'jc_price', r.chain_payload -> 'jc_price', 'tx_hash', r.source_tx_hash, 'mint_tx', p_mint_tx))
    on conflict (idempotency_key) do nothing;
  select * into jc_row from public.jc_ledger where idempotency_key = p_request_key || ':jc';
  if jc_row.id is null then raise exception 'JC ledger finalization failed'; end if;
  update public.settlement_reservations set status = 'confirmed', settled_at = now(), updated_at = now(), chain_payload = chain_payload || jsonb_build_object('mint_tx', p_mint_tx) where request_key = p_request_key;
  return jsonb_build_object('status', 'confirmed', 'tx_hash', p_mint_tx, 'jc', r.jc_amount, 'usdt', r.usdt_amount, 'ledger_id', jc_row.id);
end;
$_$;


--
-- Name: get_agent_dashboard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_agent_dashboard() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare me public.profiles; start_month date := date_trunc('month', now())::date; members jsonb; logs jsonb; trades jsonb;
begin
 if auth.uid() is null then raise exception 'not authenticated'; end if;
 select * into me from public.profiles where id=auth.uid();
 with recursive network as (
   select p.id, 1 as level from public.profiles p where p.referrer_id=me.id or p.parent_id=me.id
   union
   select child.id, network.level+1 from network join public.profiles child
     on child.referrer_id=network.id or child.parent_id=network.id
   where network.level < 2
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'email',p.email,'display_name',p.display_name,'nickname',p.nickname,'agency_role',p.agency_role,'promo_code',p.promo_code,'referrer_id',p.referrer_id,'parent_id',p.parent_id,'master_agent_id',p.master_agent_id,'last_login_at',p.last_login_at,'created_at',p.created_at,'monthly_investment',private.month_investment(p.id,start_month),'effective',private.is_effective_member(p.id,start_month),'balance',(select coalesce(sum(l.amount),0) from public.jc_ledger l where l.user_id=p.id and l.entry_type<>'commission_pending'),'fees',(select coalesce(sum((l.metadata->>'fee')::numeric),0) from public.jc_ledger l where l.user_id=p.id and l.created_at>=start_month::timestamptz),'level',network.level) order by p.created_at desc),'[]'::jsonb) into members
 from network join public.profiles p on p.id=network.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'buyer_id',c.buyer_id,'asset_id',c.asset_id,'transaction_type',c.transaction_type,'transaction_amount',c.transaction_amount,'bonus_type',c.bonus_type,'base_rate',c.base_rate,'boost_rate',c.boost_rate,'effective_rate',c.effective_rate,'commission_amount',c.commission_amount,'paid_at',c.paid_at,'created_at',c.created_at) order by c.created_at desc),'[]'::jsonb) into logs from public.commission_logs c where c.beneficiary_id=me.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'user_id',l.user_id,'entry_type',l.entry_type,'asset_id',l.asset_id,'quantity',l.quantity,'amount',l.amount,'gross',coalesce((l.metadata->>'gross')::numeric,abs(l.amount)),'fee',coalesce((l.metadata->>'fee')::numeric,0),'created_at',l.created_at) order by l.created_at desc),'[]'::jsonb) into trades from public.jc_ledger l where l.entry_type in ('private_purchase','p2p_buy','p2p_sell') and exists(select 1 from public.profiles p where p.id=l.user_id and (p.referrer_id=me.id or p.parent_id=me.id or p.referrer_id in(select id from public.profiles where referrer_id=me.id or parent_id=me.id)));
 return jsonb_build_object('profile',jsonb_build_object('id',me.id,'email',me.email,'agency_role',me.agency_role,'promo_code',me.promo_code,'master_agent_id',me.master_agent_id),'members',members,'commissions',logs,'trades',trades,'new_effective_count',private.new_effective_count(me.id,start_month,false),'boost_rate',private.agent_six_month_boost(me.id,start_month));
end $$;


--
-- Name: get_all_agent_performance_members(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_all_agent_performance_members() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'email', p.email,
    'display_name', p.display_name,
    'nickname', p.nickname,
    'agency_role', p.agency_role,
    'promo_code', p.promo_code,
    'referrer_id', p.referrer_id,
    'parent_id', p.parent_id,
    'master_agent_id', p.master_agent_id,
    'last_login_at', p.last_login_at,
    'created_at', p.created_at,
    'level', null,
    'monthly_investment', 0,
    'effective', false,
    'fees', 0
  ) order by p.created_at desc), '[]'::jsonb)
  from public.profiles p;
$$;


--
-- Name: get_asset_volumes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_asset_volumes() RETURNS TABLE(asset_id text, volume_jc numeric)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select l.asset_id, sum(abs(l.amount)) as volume_jc
  from public.jc_ledger l
  where l.asset_id is not null
    and l.entry_type in ('private_purchase', 'p2p_buy')
  group by l.asset_id;
$$;


--
-- Name: get_maintenance_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_maintenance_state() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select jsonb_build_object('enabled', coalesce(maintenance_mode, false), 'reason', maintenance_reason)
  from public.platform_config where id = true;
$$;


--
-- Name: get_market_price_snapshots(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_market_price_snapshots(asset_key text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case when auth.uid() is null then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'asset_id', s.asset_id,
    'price', s.price,
    'recorded_at', s.recorded_at
  ) order by s.recorded_at asc), '[]'::jsonb) end
  from public.market_price_snapshots s
  where s.asset_id = asset_key;
$$;


--
-- Name: get_market_trade_volumes(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_market_trade_volumes(asset_key text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case when auth.uid() is null then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
    'quantity', abs(l.quantity),
    'recorded_at', l.created_at
  ) order by l.created_at asc), '[]'::jsonb) end
  from public.jc_ledger l
  where l.asset_id = asset_key and l.entry_type = 'p2p_buy';
$$;


--
-- Name: FUNCTION get_market_trade_volumes(asset_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_market_trade_volumes(asset_key text) IS 'Returns one volume row per secondary-market fill from the buyer-side JC ledger entry, avoiding mirrored seller-side double counts.';


--
-- Name: get_my_jc_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_jc_balance() RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case when auth.uid() is null then 0::numeric
    else greatest(coalesce((select sum(l.amount) filter (where l.entry_type <> 'commission_pending')
      from public.jc_ledger l where l.user_id = auth.uid()), 0) - private.settlement_reserved_jc(auth.uid()), 0)::numeric
  end;
$$;


--
-- Name: get_my_p2p_orders(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_p2p_orders(p_escrow_contract_address text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: get_my_rwmt_town_transactions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_rwmt_town_transactions() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select coalesce(jsonb_agg(jsonb_build_object('id','town-'||o.id::text,'kind',case when o.result='bomb' then 'bomb' else 'ae' end,'house',o.house_index,'amount',case when o.result='bomb' then abs(o.jc_penalty) else 1 end,'net',case when o.result='bomb' then -abs(o.jc_penalty) else 1 end,'tx_hash',o.ae_tx_hash,'status',case when o.result='ae' then case when o.prize_status='paid' then 'confirmed' else 'pending' end else 'confirmed' end,'created_at',o.created_at,'paid_at',o.ae_paid_at) order by o.created_at desc),'[]'::jsonb) from public.rwmt_town_opens o where o.user_id=auth.uid() and (o.result='bomb' or o.result='ae'); $$;


--
-- Name: get_my_wallet_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_wallet_balance() RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select case
    when auth.uid() is null then 0::numeric
    else coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0)::numeric
  end
  from public.asset_ledger l
  where l.user_id = auth.uid();
$$;


--
-- Name: get_p2p_order_book(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_p2p_order_book(asset_key text DEFAULT NULL::text, p_escrow_contract_address text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: get_rwmt_town_challenge(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_rwmt_town_challenge(p_house integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.rwmt_town_rounds; q text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1;
  if not found then raise exception 'no active round'; end if;
  if p_house < 0 or p_house >= r.house_count then raise exception 'invalid house'; end if;
  select c.question into q from private.rwmt_challenge(r.seed, p_house) c;
  return jsonb_build_object('house', p_house, 'question', q);
end
$$;


--
-- Name: get_rwmt_town_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_rwmt_town_state() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare r public.rwmt_town_rounds; cfg jsonb; opened jsonb := '[]'::jsonb;
begin
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1;
  if not found then
    select * into r from public.rwmt_town_rounds order by id desc limit 1;
  end if;
  select rwmt_town_config into cfg from public.platform_config where id = true;
  if r.id is not null and auth.uid() is not null then
    select coalesce(jsonb_agg(jsonb_build_object('house', o.house_index, 'result', o.result)), '[]'::jsonb)
      into opened from public.rwmt_town_opens o where o.round_id = r.id and o.user_id = auth.uid();
  end if;
  return jsonb_build_object(
    'config', coalesce(cfg, '{}'::jsonb),
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'round_no', r.round_no, 'theme', r.theme, 'night', r.night,
      'house_count', r.house_count, 'ae_total', r.ae_total, 'ae_remaining', r.ae_remaining,
      'bomb_jc', r.bomb_jc, 'status', r.status, 'started_at', r.started_at, 'ended_at', r.ended_at) end,
    'opened', opened);
end
$$;


--
-- Name: get_safe_vault_address(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_safe_vault_address() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (select active_safe_address from public.platform_config where id = true),
    '0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf'
  )
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role, balance)
  VALUES (new.id, new.email, 'user', 0);
  RETURN new;
END;
$$;


--
-- Name: is_current_user_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_current_user_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$ select auth.uid() is not null and private.is_admin() $$;


--
-- Name: list_visible_private_placements(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_visible_private_placements() RETURNS SETOF public.private_placements
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p.*
  FROM public.private_placements AS p
  WHERE p.is_delisted = false
    AND p.updated_at >= TIMESTAMPTZ '2026-10-04 11:57:00+08'
  ORDER BY p.created_at;
$$;


--
-- Name: FUNCTION list_visible_private_placements(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_visible_private_placements() IS 'Lists non-delisted placements updated since 2026-10-04 11:57 Asia/Taipei.';


--
-- Name: my_available_ae(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_available_ae() RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select private.available_ae(auth.uid())
$$;


--
-- Name: my_encumbered_ae(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_encumbered_ae() RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select private.encumbered_ae(auth.uid())
$$;


--
-- Name: process_commission(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_commission(p_trader_id uuid, p_amount numeric, p_project_id text DEFAULT NULL::text, p_market_type text DEFAULT 'private'::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() is null or auth.uid() <> p_trader_id then
    raise exception 'not authorized';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  if p_market_type not in ('private', 'secondary') then
    raise exception 'invalid market type';
  end if;

  -- Compatibility endpoint only. Current trade RPCs create commissions atomically.
  -- Returning successfully prevents retired clients from rolling back otherwise valid trades,
  -- without creating duplicate commission records from client-supplied amounts.
  return;
end;
$$;


--
-- Name: release_p2p_escrow_order_reservation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_p2p_escrow_order_reservation(p_request_key uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: release_unsubmitted_vault_jc_purchase(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_unsubmitted_vault_jc_purchase(request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: request_jc_redemption(numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare px numeric; usdt numeric; jc_bal numeric; wallet text; prior public.redemption_orders; order_row public.redemption_orders;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(auth.uid()) then raise exception 'account is blacklisted' using errcode = '42501'; end if;
  if request_key is null or length(trim(request_key)) < 8 then raise exception 'invalid request key'; end if;
  if jc_amount is null or jc_amount <= 0 or jc_amount > 100000000 then raise exception 'invalid amount'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;
  select * into prior from public.redemption_orders where idempotency_key = request_key for update;
  if found then
    if prior.user_id <> auth.uid() or prior.jc_amount <> jc_amount then raise exception 'request key already used'; end if;
    return jsonb_build_object('order_id', prior.id, 'jc_amount', prior.jc_amount, 'usdt_amount', prior.usdt_amount, 'jc_price', prior.jc_price, 'status', prior.status, 'idempotent', true);
  end if;
  select wallet_address into wallet from public.profiles where id = auth.uid();
  if wallet is null or length(trim(wallet)) = 0 then raise exception 'no wallet bound'; end if;
  select jc_redeem_price into px from public.platform_config where id = true;
  if px is null or px <= 0 then raise exception 'jc redemption price unavailable'; end if;
  usdt := round(jc_amount * px, 6);
  if usdt <= 0 then raise exception 'invalid amount'; end if;
  select coalesce(sum(l.amount) filter (where l.entry_type <> 'commission_pending'), 0) - private.settlement_reserved_jc(auth.uid()) into jc_bal from public.jc_ledger l where l.user_id = auth.uid();
  if jc_bal < jc_amount then raise exception 'insufficient jc'; end if;
  insert into public.settlement_reservations(request_key, action, user_id, jc_amount, usdt_amount, wallet_address, chain_payload)
    values(request_key, 'redeem', auth.uid(), jc_amount, usdt, wallet, jsonb_build_object('jc_price', px));
  insert into public.redemption_orders(user_id, wallet_address, jc_amount, usdt_amount, jc_price, idempotency_key)
    values(auth.uid(), wallet, jc_amount, usdt, px, request_key) returning * into order_row;
  update public.settlement_reservations set chain_payload = chain_payload || jsonb_build_object('order_id', order_row.id)
    where settlement_reservations.request_key = request_jc_redemption.request_key;
  return jsonb_build_object('order_id', order_row.id, 'jc_amount', jc_amount, 'usdt_amount', usdt, 'jc_price', px, 'status', 'pending');
end;
$$;


--
-- Name: FUNCTION request_jc_redemption(jc_amount numeric, request_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text) IS 'Reserves JC for redemption; formal debit is finalized after confirmed JC collection and USDT payout.';


--
-- Name: reserve_p2p_escrow_order(text, text, numeric, numeric, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_p2p_escrow_order(p_asset_key text, p_side text, p_price numeric, p_quantity numeric, p_request_key uuid, p_client_order_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
  reserve_jc := case when p_side='sell' then coalesce((select c.p2p_listing_fee from public.platform_config c limit 1),1) else gross end;

  select * into prior from public.p2p_escrow_order_reservations where request_key=p_request_key;
  if found then
    if prior.user_id<>auth.uid() or prior.asset_id<>p_asset_key or prior.side<>p_side
      or prior.price<>fixed_price or prior.quantity<>p_quantity or prior.client_order_id<>lower(p_client_order_id) then
      raise exception 'request key already used';
    end if;
    return jsonb_build_object('request_key',prior.request_key,'status',prior.status,'reserved_jc',prior.reserved_jc);
  end if;
  if exists(select 1 from public.p2p_escrow_order_reservations where client_order_id=lower(p_client_order_id)) then
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
$_$;


--
-- Name: reserve_vault_jc_purchase(numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_vault_jc_purchase(jc_amount numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: agency_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agency_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    requested_role text NOT NULL,
    contact_name text NOT NULL,
    contact_method text NOT NULL,
    region text NOT NULL,
    reason text NOT NULL,
    master_promo_code text,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agency_applications_requested_role_check CHECK ((requested_role = ANY (ARRAY['代理'::text, '總代理'::text]))),
    CONSTRAINT agency_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: review_agency_application(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_agency_application(application_id uuid, decision text, reject_reason text DEFAULT NULL::text) RETURNS public.agency_applications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  app public.agency_applications;
  master public.profiles;
  admin_email text;
  generated text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'invalid decision';
  end if;
  select * into app
  from public.agency_applications
  where id = application_id and status = 'pending'
  for update;
  if not found then
    raise exception 'application unavailable';
  end if;
  if decision = 'approved' then
    generated := private.generate_promo_code();
    if app.requested_role = '代理' then
      if nullif(trim(app.master_promo_code), '') is not null then
        select * into master
        from public.profiles
        where upper(promo_code) = upper(trim(app.master_promo_code))
          and agency_role = '總代理';
        if not found then
          raise exception 'master agent unavailable';
        end if;
      else
        select * into master
        from public.profiles
        where id = (
          select current_profile.master_agent_id
          from public.profiles current_profile
          where current_profile.id = app.user_id
        )
          and agency_role = '總代理';
      end if;
    end if;
    update public.profiles
    set agency_role = app.requested_role,
        promo_code = coalesce(promo_code, generated),
        master_agent_id = case when app.requested_role = '代理' then master.id else null end,
        role_approved_at = now()
    where id = app.user_id;
    insert into public.referral_binding_logs (
      user_id, new_master_agent_id, action, reason, actor_id
    )
    values (
      app.user_id,
      case when app.requested_role = '代理' then master.id else null end,
      'agency_approval',
      'Admin 核准代理申請',
      auth.uid()
    );
  end if;
  update public.agency_applications
  set status = decision,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = case when decision = 'rejected' then nullif(trim(reject_reason), '') else null end,
      updated_at = now()
  where id = application_id
  returning * into app;
  select email into admin_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs (
    admin_id, admin_email, action, target_type, target_id, details
  )
  values (
    auth.uid(), admin_email, 'review_agency_application', 'agency_application', application_id::text,
    jsonb_build_object('decision', decision, 'user_id', app.user_id, 'requested_role', app.requested_role)
  );
  return app;
end
$$;


--
-- Name: FUNCTION review_agency_application(application_id uuid, decision text, reject_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.review_agency_application(application_id uuid, decision text, reject_reason text) IS 'Reviews agency applications; agent applications without a selected master remain unassigned until an admin binds them.';


--
-- Name: rwmt_town_open_house(integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rwmt_town_open_house(p_house integer, p_answer bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  uid uuid := auth.uid(); r public.rwmt_town_rounds; expected bigint; existing text;
  opened_houses int; remaining int; x double precision; res text := 'empty';
  penalty numeric := 0; p_status text := 'none'; prize text := 'none'; bal numeric;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(uid) then raise exception 'account frozen' using errcode = '42501'; end if;
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1 for update;
  if not found then raise exception 'no active round'; end if;
  if p_house < 0 or p_house >= r.house_count then raise exception 'invalid house'; end if;

  select o.result into existing from public.rwmt_town_opens o
    where o.round_id = r.id and o.user_id = uid and o.house_index = p_house;
  if existing is not null then
    return jsonb_build_object('correct', true, 'already', true, 'result', existing,
      'ae_remaining', r.ae_remaining, 'ae_total', r.ae_total, 'status', r.status);
  end if;

  if exists (select 1 from public.rwmt_town_opens o where o.user_id = uid and o.penalty_status = 'cooldown'
             and o.created_at > now() - interval '10 minutes') then
    raise exception 'cooldown';
  end if;

  select c.answer into expected from private.rwmt_challenge(r.seed, p_house) c;
  if p_answer is distinct from expected then
    return jsonb_build_object('correct', false);
  end if;

  select count(distinct o.house_index) into opened_houses from public.rwmt_town_opens o where o.round_id = r.id;
  remaining := greatest(r.house_count - opened_houses, r.ae_remaining + r.bomb_remaining, 1);
  x := random();

  if r.ae_remaining > 0 and x < r.ae_remaining::double precision / remaining then
    res := 'ae'; prize := 'pending';
    update public.rwmt_town_rounds set ae_remaining = ae_remaining - 1,
      status = case when ae_remaining - 1 = 0 then 'ended' else status end,
      ended_at = case when ae_remaining - 1 = 0 then now() else ended_at end
      where id = r.id returning * into r;
  elsif r.bomb_remaining > 0 and x < (r.ae_remaining + r.bomb_remaining)::double precision / remaining then
    res := 'bomb';
    update public.rwmt_town_rounds set bomb_remaining = bomb_remaining - 1 where id = r.id returning * into r;
    bal := public.get_my_jc_balance();
    if r.bomb_jc > 0 and bal >= r.bomb_jc then
      insert into public.jc_ledger (user_id, entry_type, amount, idempotency_key, metadata)
      values (uid, 'town_bomb', -r.bomb_jc, 'town-bomb:' || r.id || ':' || uid || ':' || p_house,
              jsonb_build_object('round_id', r.id, 'house', p_house));
      penalty := r.bomb_jc; p_status := 'charged';
    elsif r.bomb_jc > 0 then
      p_status := 'cooldown';
    end if;
  end if;

  insert into public.rwmt_town_opens (round_id, user_id, house_index, result, jc_penalty, penalty_status, prize_status)
  values (r.id, uid, p_house, res, penalty, p_status, prize);

  return jsonb_build_object('correct', true, 'result', res, 'jc_penalty', penalty, 'penalty_status', p_status,
    'ae_remaining', r.ae_remaining, 'ae_total', r.ae_total, 'status', r.status);
end
$$;


--
-- Name: sandbox_deposit(uuid, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sandbox_deposit(target_user_id uuid, deposit_amount numeric, request_key text) RETURNS public.asset_ledger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$ declare result public.asset_ledger; admin_email text; begin if not private.is_admin() then raise exception 'not authorized'; end if; if deposit_amount<=0 or deposit_amount>1000000 then raise exception 'invalid amount'; end if; select * into result from public.asset_ledger where idempotency_key=request_key; if found then return result; end if; select email into admin_email from public.profiles where id=auth.uid(); insert into public.asset_ledger(user_id,entry_type,amount,idempotency_key,metadata) values(target_user_id,'sandbox_deposit',deposit_amount,request_key,jsonb_build_object('sandbox',true)) returning * into result; insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details) values(auth.uid(),admin_email,'sandbox_deposit','profile',target_user_id::text,jsonb_build_object('amount',deposit_amount,'ledger_id',result.id)); return result; end $$;


--
-- Name: service_set_active_safe(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.service_set_active_safe(p_address text, p_admin_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
begin
  if p_address is null or p_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'invalid safe address';
  end if;
  update public.platform_config
  set active_safe_address = p_address,
      active_safe_updated_at = now(),
      updated_at = now(),
      updated_by = coalesce(p_admin_id, updated_by)
  where id = true;
  return p_address;
end;
$_$;


--
-- Name: service_set_p2p_fees(integer, numeric, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.service_set_p2p_fees(p_fee_bps integer, p_listing_fee numeric, p_admin_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  update public.platform_config
    set p2p_fee_bps=p_fee_bps, p2p_listing_fee=round(p_listing_fee,6), p2p_fees_updated_at=now(), updated_at=now(), updated_by=p_admin_id;
  return jsonb_build_object('fee_bps',p_fee_bps,'listing_fee',round(p_listing_fee,6));
end $$;


--
-- Name: set_own_promo_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_own_promo_code(new_code text) RETURNS public.profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$ declare normalized text:=upper(trim(new_code)); result public.profiles; begin if auth.uid() is null then raise exception 'not authenticated'; end if; if normalized !~ '^[A-Z0-9]{9}$' then raise exception 'promo code must be 9 alphanumeric characters'; end if; if not exists(select 1 from public.profiles where id=auth.uid() and agency_role in ('代理','一代代理','二代代理','總代理')) then raise exception 'not an approved agent'; end if; if exists(select 1 from public.profiles where upper(promo_code)=normalized and id<>auth.uid()) then raise exception 'promo code already used'; end if; update public.profiles set promo_code=normalized where id=auth.uid() returning * into result; return result; end $_$;


--
-- Name: set_user_preferences_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_user_preferences_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: submit_agency_application(text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text DEFAULT NULL::text) RETURNS public.agency_applications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  result public.agency_applications;
  master public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_role not in ('代理', '總代理') then
    raise exception 'invalid role';
  end if;
  if length(trim(p_name)) < 2
    or length(trim(p_contact)) < 3
    or length(trim(p_region)) < 2
    or length(trim(p_reason)) < 5 then
    raise exception 'incomplete application';
  end if;
  if exists (
    select 1 from public.agency_applications
    where user_id = auth.uid() and status = 'pending'
  ) then
    raise exception 'application pending';
  end if;
  if p_role = '代理' and nullif(trim(p_master_code), '') is not null then
    select * into master
    from public.profiles
    where upper(promo_code) = upper(trim(p_master_code))
      and agency_role = '總代理';
    if not found then
      raise exception 'invalid master promo code';
    end if;
  end if;
  insert into public.agency_applications (
    user_id, requested_role, contact_name, contact_method, region, reason, master_promo_code
  )
  values (
    auth.uid(), p_role, trim(p_name), trim(p_contact), trim(p_region), trim(p_reason),
    case when p_role = '代理' then nullif(upper(trim(p_master_code)), '') else null end
  )
  returning * into result;
  return result;
end
$$;


--
-- Name: FUNCTION submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text) IS 'Applies for an agency role; master promo code is optional so applicants can submit by role only.';


--
-- Name: sync_auth_user_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_auth_user_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.profiles (id,email,display_name,created_at,last_sign_in_at,updated_at)
  values (
    new.id,
    coalesce(new.email,''),
    coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name'),
    coalesce(new.created_at,now()),
    new.last_sign_in_at,
    now()
  )
  on conflict (id) do update set
    email=excluded.email,
    display_name=coalesce(excluded.display_name,public.profiles.display_name),
    last_sign_in_at=excluded.last_sign_in_at,
    updated_at=now();
  return new;
end;
$$;


--
-- Name: touch_last_login(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_last_login() RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$ update public.profiles set last_login_at=now() where id=auth.uid() $$;


--
-- Name: touch_telegram_notification_preferences_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_telegram_notification_preferences_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: vault_buy_jc_onchain(numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: FUNCTION vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text) IS 'Creates a pending JC vault-purchase reservation; formal ledger entries wait for verified USDT receipt and JC delivery.';


--
-- Name: vault_exchange_jc(text, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_exchange_jc(direction text, jc_amount numeric, request_key text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if direction not in ('buy','redeem') then raise exception 'invalid direction'; end if;
  if direction = 'redeem' then
    raise exception 'use request_jc_redemption instead';
  end if;
  raise exception 'use vault_buy_jc_onchain instead';
end
$$;


--
-- Name: admin_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    admin_email text NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_state (
    key text NOT NULL,
    last_run_at timestamp with time zone DEFAULT '1970-01-01 08:00:00+08'::timestamp with time zone NOT NULL
);


--
-- Name: background_push_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_push_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    removed_count integer DEFAULT 0 NOT NULL,
    sent_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    target_count integer DEFAULT 0 NOT NULL,
    subscriber_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT background_push_logs_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 500))),
    CONSTRAINT background_push_logs_failed_count_check CHECK ((failed_count >= 0)),
    CONSTRAINT background_push_logs_removed_count_check CHECK ((removed_count >= 0)),
    CONSTRAINT background_push_logs_sent_count_check CHECK ((sent_count >= 0)),
    CONSTRAINT background_push_logs_subscriber_count_check CHECK ((subscriber_count >= 0)),
    CONSTRAINT background_push_logs_target_count_check CHECK ((target_count >= 0)),
    CONSTRAINT background_push_logs_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 120)))
);


--
-- Name: commission_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    buyer_id uuid NOT NULL,
    asset_id text,
    transaction_type text NOT NULL,
    transaction_amount numeric(20,6) NOT NULL,
    commission_rate numeric(10,6) NOT NULL,
    commission_amount numeric(20,6) NOT NULL,
    ledger_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    bonus_type text,
    beneficiary_id uuid,
    source_agent_id uuid,
    source_user_id uuid,
    source_ledger_id uuid,
    base_rate numeric(10,6) DEFAULT 0 NOT NULL,
    boost_rate numeric(10,6) DEFAULT 0 NOT NULL,
    effective_rate numeric(10,6) DEFAULT 0 NOT NULL,
    calculation_month date,
    paid_at timestamp with time zone,
    payout_batch_id uuid,
    ae_price_snapshot numeric,
    transaction_amount_ae numeric,
    commission_amount_ae numeric,
    display_currency text DEFAULT 'ae'::text NOT NULL,
    CONSTRAINT commission_logs_bonus_type_check CHECK (((bonus_type IS NULL) OR (bonus_type = ANY (ARRAY['personal'::text, 'team'::text, 'self_rebate'::text, 'l1'::text, 'l2'::text])))),
    CONSTRAINT commission_logs_commission_amount_check CHECK ((commission_amount > (0)::numeric)),
    CONSTRAINT commission_logs_commission_rate_check CHECK ((commission_rate > (0)::numeric)),
    CONSTRAINT commission_logs_display_currency_check CHECK ((display_currency = ANY (ARRAY['usdt'::text, 'ae'::text, 'jc'::text]))),
    CONSTRAINT commission_logs_transaction_amount_check CHECK ((transaction_amount > (0)::numeric)),
    CONSTRAINT commission_logs_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['private'::text, 'secondary'::text])))
);


--
-- Name: commission_processing_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_processing_errors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    asset_id text,
    transaction_type text NOT NULL,
    gross numeric NOT NULL,
    source_ledger_id uuid,
    request_key text NOT NULL,
    error_message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_processing_errors_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['private'::text, 'secondary'::text])))
);


--
-- Name: commission_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_settings (
    agency_role text NOT NULL,
    rate numeric NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    private_rate numeric NOT NULL,
    secondary_rate numeric NOT NULL,
    asset_mode text DEFAULT 'ae_coin'::text NOT NULL,
    CONSTRAINT commission_settings_asset_mode_check CHECK ((asset_mode = ANY (ARRAY['ae_coin'::text, 'rwa'::text]))),
    CONSTRAINT commission_settings_private_rate_check CHECK (((private_rate >= (0)::numeric) AND (private_rate <= (1)::numeric))),
    CONSTRAINT commission_settings_rate_check CHECK (((rate >= (0)::numeric) AND (rate <= (1)::numeric))),
    CONSTRAINT commission_settings_secondary_rate_check CHECK (((secondary_rate >= (0)::numeric) AND (secondary_rate <= (1)::numeric)))
);


--
-- Name: commission_user_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_user_overrides (
    user_id uuid NOT NULL,
    private_rate numeric,
    secondary_rate numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    asset_mode text DEFAULT 'ae_coin'::text NOT NULL,
    self_private_rate numeric,
    l1_private_rate numeric,
    l2_private_rate numeric,
    self_secondary_rate numeric,
    l1_secondary_rate numeric,
    l2_secondary_rate numeric,
    CONSTRAINT commission_user_overrides_asset_mode_check CHECK ((asset_mode = ANY (ARRAY['ae_coin'::text, 'rwa'::text]))),
    CONSTRAINT commission_user_overrides_l1_private_rate_range CHECK (((l1_private_rate IS NULL) OR ((l1_private_rate >= (0)::numeric) AND (l1_private_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_l1_secondary_rate_range CHECK (((l1_secondary_rate IS NULL) OR ((l1_secondary_rate >= (0)::numeric) AND (l1_secondary_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_l2_private_rate_range CHECK (((l2_private_rate IS NULL) OR ((l2_private_rate >= (0)::numeric) AND (l2_private_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_l2_secondary_rate_range CHECK (((l2_secondary_rate IS NULL) OR ((l2_secondary_rate >= (0)::numeric) AND (l2_secondary_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_private_rate_check CHECK (((private_rate IS NULL) OR ((private_rate >= (0)::numeric) AND (private_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_secondary_rate_check CHECK (((secondary_rate IS NULL) OR ((secondary_rate >= (0)::numeric) AND (secondary_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_self_private_rate_range CHECK (((self_private_rate IS NULL) OR ((self_private_rate >= (0)::numeric) AND (self_private_rate <= (1)::numeric)))),
    CONSTRAINT commission_user_overrides_self_secondary_rate_range CHECK (((self_secondary_rate IS NULL) OR ((self_secondary_rate >= (0)::numeric) AND (self_secondary_rate <= (1)::numeric))))
);


--
-- Name: holdings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.holdings (
    user_id uuid NOT NULL,
    asset_id text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT holdings_quantity_check CHECK ((quantity >= (0)::numeric))
);


--
-- Name: jc_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jc_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    entry_type text NOT NULL,
    amount numeric NOT NULL,
    asset_id text,
    quantity numeric,
    idempotency_key text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: market_price_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_price_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id text NOT NULL,
    price numeric NOT NULL,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT market_price_snapshots_price_check CHECK ((price > (0)::numeric))
);


--
-- Name: onchain_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onchain_settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    ref_key text NOT NULL,
    user_id uuid,
    counterparty_id uuid,
    asset_id text,
    amount numeric,
    payment numeric,
    tx_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT onchain_settlements_action_check CHECK ((action = ANY (ARRAY['mint_jc'::text, 'subscribe'::text, 'trade'::text, 'wire_contracts'::text, 'commission'::text, 'list_fee'::text, 'admin_payout'::text, 'ae_reclaim_legacy'::text, 'redeem'::text]))),
    CONSTRAINT onchain_settlements_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: p2p_escrow_cutover_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.p2p_escrow_cutover_audit (
    order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    asset_id text NOT NULL,
    side text NOT NULL,
    status_before text NOT NULL,
    remaining_quantity numeric NOT NULL,
    cancelled_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text DEFAULT 'legacy order cancelled for escrow cutover'::text NOT NULL
);


--
-- Name: p2p_escrow_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.p2p_escrow_events (
    tx_hash text NOT NULL,
    event_type text NOT NULL,
    user_id uuid,
    event_data jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT p2p_escrow_events_event_type_check CHECK ((event_type = ANY (ARRAY['order_created'::text, 'order_filled'::text, 'order_cancelled'::text]))),
    CONSTRAINT p2p_escrow_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'failed'::text, 'finalized'::text])))
);


--
-- Name: p2p_escrow_fills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.p2p_escrow_fills (
    fill_key text NOT NULL,
    tx_hash text NOT NULL,
    chain_order_id numeric(78,0) NOT NULL,
    order_id uuid NOT NULL,
    buyer_id uuid NOT NULL,
    seller_id uuid NOT NULL,
    asset_id text NOT NULL,
    quantity numeric NOT NULL,
    price numeric NOT NULL,
    gross numeric NOT NULL,
    platform_fee numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    counter_chain_order_id numeric(78,0),
    counter_order_id uuid,
    CONSTRAINT p2p_escrow_fills_gross_check CHECK ((gross > (0)::numeric)),
    CONSTRAINT p2p_escrow_fills_platform_fee_check CHECK ((platform_fee >= (0)::numeric)),
    CONSTRAINT p2p_escrow_fills_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT p2p_escrow_fills_quantity_check CHECK ((quantity > (0)::numeric))
);


--
-- Name: p2p_escrow_order_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.p2p_escrow_order_reservations (
    request_key uuid NOT NULL,
    client_order_id text NOT NULL,
    user_id uuid NOT NULL,
    asset_id text NOT NULL,
    side text NOT NULL,
    price numeric NOT NULL,
    quantity numeric NOT NULL,
    reserved_jc numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT p2p_escrow_order_reservations_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT p2p_escrow_order_reservations_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT p2p_escrow_order_reservations_reserved_jc_check CHECK ((reserved_jc >= (0)::numeric)),
    CONSTRAINT p2p_escrow_order_reservations_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT p2p_escrow_order_reservations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'released'::text])))
);


--
-- Name: p2p_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.p2p_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset_id text NOT NULL,
    side text NOT NULL,
    price numeric NOT NULL,
    original_quantity numeric NOT NULL,
    remaining_quantity numeric NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    escrow_mode text DEFAULT 'legacy'::text NOT NULL,
    escrow_request_key text,
    escrow_chain_order_id numeric(78,0),
    escrow_create_tx_hash text,
    escrow_token_address text,
    escrow_currency_address text,
    escrow_locked_currency numeric DEFAULT 0 NOT NULL,
    escrow_contract_address text,
    fee_bps integer,
    listing_fee numeric,
    CONSTRAINT p2p_orders_check CHECK ((remaining_quantity <= original_quantity)),
    CONSTRAINT p2p_orders_original_quantity_check CHECK (((original_quantity > (0)::numeric) AND (original_quantity = round(original_quantity, 6)))),
    CONSTRAINT p2p_orders_price_check CHECK ((price > (0)::numeric)),
    CONSTRAINT p2p_orders_remaining_quantity_check CHECK (((remaining_quantity >= (0)::numeric) AND (remaining_quantity = round(remaining_quantity, 6)))),
    CONSTRAINT p2p_orders_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT p2p_orders_status_check CHECK ((status = ANY (ARRAY['open'::text, 'partially_filled'::text, 'filled'::text, 'cancelled'::text])))
);


--
-- Name: platform_fee_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_fee_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    payer_id uuid NOT NULL,
    asset_id text,
    amount numeric NOT NULL,
    treasury_address text DEFAULT '0x199a423317cE38349574Deb652E4841C29D0De8A'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_fee_ledger_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT platform_fee_ledger_source_type_check CHECK ((source_type = ANY (ARRAY['p2p_fee'::text, 'p2p_gas'::text, 'private_principal'::text, 'private_gas'::text, 'safe_treasury'::text])))
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: redemption_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redemption_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    wallet_address text NOT NULL,
    jc_amount numeric NOT NULL,
    usdt_amount numeric NOT NULL,
    jc_price numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    jc_ledger_id uuid,
    tx_hash text,
    idempotency_key text,
    admin_id uuid,
    admin_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT redemption_orders_jc_amount_check CHECK ((jc_amount > (0)::numeric)),
    CONSTRAINT redemption_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'rejected'::text]))),
    CONSTRAINT redemption_orders_usdt_amount_check CHECK ((usdt_amount > (0)::numeric))
);


--
-- Name: referral_binding_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_binding_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    old_referrer_id uuid,
    new_referrer_id uuid,
    old_master_agent_id uuid,
    new_master_agent_id uuid,
    action text NOT NULL,
    reason text NOT NULL,
    actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rwa_placement_escrows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rwa_placement_escrows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    asset_id text NOT NULL,
    quantity numeric NOT NULL,
    ae_locked numeric(30,6) NOT NULL,
    ae_per_share_at_purchase numeric(30,6),
    status text DEFAULT 'locked'::text NOT NULL,
    request_key text NOT NULL,
    ae_settled numeric(30,6),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT rwa_placement_escrows_ae_locked_check CHECK ((ae_locked >= (0)::numeric)),
    CONSTRAINT rwa_placement_escrows_quantity_check CHECK ((quantity > (0)::numeric)),
    CONSTRAINT rwa_placement_escrows_status_check CHECK ((status = ANY (ARRAY['locked'::text, 'settled'::text, 'cancelled'::text])))
);


--
-- Name: rwmt_town_opens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rwmt_town_opens (
    id bigint NOT NULL,
    round_id bigint NOT NULL,
    user_id uuid NOT NULL,
    house_index integer NOT NULL,
    result text NOT NULL,
    jc_penalty numeric DEFAULT 0 NOT NULL,
    penalty_status text DEFAULT 'none'::text NOT NULL,
    prize_status text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ae_tx_hash text,
    ae_paid_at timestamp with time zone,
    CONSTRAINT rwmt_town_opens_penalty_status_check CHECK ((penalty_status = ANY (ARRAY['none'::text, 'charged'::text, 'cooldown'::text]))),
    CONSTRAINT rwmt_town_opens_prize_status_check CHECK ((prize_status = ANY (ARRAY['none'::text, 'pending'::text, 'paid'::text]))),
    CONSTRAINT rwmt_town_opens_result_check CHECK ((result = ANY (ARRAY['ae'::text, 'bomb'::text, 'empty'::text])))
);


--
-- Name: rwmt_town_opens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rwmt_town_opens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rwmt_town_opens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rwmt_town_opens_id_seq OWNED BY public.rwmt_town_opens.id;


--
-- Name: rwmt_town_rounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rwmt_town_rounds (
    id bigint NOT NULL,
    round_no integer NOT NULL,
    theme text DEFAULT 'modern'::text NOT NULL,
    night boolean DEFAULT false NOT NULL,
    house_count integer NOT NULL,
    ae_total integer NOT NULL,
    ae_remaining integer NOT NULL,
    bomb_total integer NOT NULL,
    bomb_remaining integer NOT NULL,
    bomb_jc numeric DEFAULT 0.1 NOT NULL,
    seed bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT rwmt_town_rounds_ae_remaining_check CHECK ((ae_remaining >= 0)),
    CONSTRAINT rwmt_town_rounds_ae_total_check CHECK ((ae_total >= 1)),
    CONSTRAINT rwmt_town_rounds_bomb_jc_check CHECK ((bomb_jc >= (0)::numeric)),
    CONSTRAINT rwmt_town_rounds_bomb_remaining_check CHECK ((bomb_remaining >= 0)),
    CONSTRAINT rwmt_town_rounds_bomb_total_check CHECK ((bomb_total >= 0)),
    CONSTRAINT rwmt_town_rounds_house_count_check CHECK (((house_count >= 18) AND (house_count <= 10000))),
    CONSTRAINT rwmt_town_rounds_status_check CHECK ((status = ANY (ARRAY['active'::text, 'ended'::text]))),
    CONSTRAINT rwmt_town_rounds_theme_check CHECK ((theme = ANY (ARRAY['modern'::text, 'cyber'::text, 'medieval'::text, 'steam'::text])))
);


--
-- Name: rwmt_town_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rwmt_town_rounds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rwmt_town_rounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rwmt_town_rounds_id_seq OWNED BY public.rwmt_town_rounds.id;


--
-- Name: safe_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.safe_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary text NOT NULL,
    safe_address text NOT NULL,
    chain_id integer NOT NULL,
    to_address text NOT NULL,
    value text DEFAULT '0'::text NOT NULL,
    data text NOT NULL,
    operation smallint NOT NULL,
    safe_nonce bigint NOT NULL,
    safe_tx_hash text NOT NULL,
    signatures jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    exec_tx_hash text,
    result jsonb,
    error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    executed_at timestamp with time zone,
    CONSTRAINT safe_proposals_operation_check CHECK ((operation = ANY (ARRAY[0, 1]))),
    CONSTRAINT safe_proposals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'executing'::text, 'executed'::text, 'failed'::text, 'stale'::text, 'cancelled'::text])))
);


--
-- Name: settlement_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_reservations (
    request_key text NOT NULL,
    action text NOT NULL,
    user_id uuid NOT NULL,
    asset_id text,
    quantity numeric,
    jc_amount numeric NOT NULL,
    usdt_amount numeric,
    wallet_address text,
    source_tx_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    chain_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT settlement_reservations_action_check CHECK ((action = ANY (ARRAY['subscribe'::text, 'vault_buy'::text, 'redeem'::text]))),
    CONSTRAINT settlement_reservations_jc_amount_check CHECK ((jc_amount > (0)::numeric)),
    CONSTRAINT settlement_reservations_quantity_check CHECK (((quantity IS NULL) OR (quantity > (0)::numeric))),
    CONSTRAINT settlement_reservations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'released'::text]))),
    CONSTRAINT settlement_reservations_usdt_check CHECK (((usdt_amount IS NULL) OR (usdt_amount > (0)::numeric)))
);


--
-- Name: TABLE settlement_reservations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.settlement_reservations IS 'Pending cross-system settlement holds. Pending rows reserve JC/inventory but do not represent completed ledger entries.';


--
-- Name: system_monitor_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_monitor_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    event_key text,
    severity text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: system_monitor_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_monitor_state (
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_delivery_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_delivery_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    target_user_id uuid,
    sent_by uuid,
    category text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telegram_delivery_logs_category_check CHECK ((category = ANY (ARRAY['market_alert'::text, 'commission'::text, 'order_partial_fill'::text, 'order_completed'::text, 'admin_direct'::text]))),
    CONSTRAINT telegram_delivery_logs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: telegram_link_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_link_tokens (
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_notification_preferences (
    user_id uuid NOT NULL,
    market_alerts_enabled boolean DEFAULT true NOT NULL,
    commission_updates_enabled boolean DEFAULT true NOT NULL,
    order_partial_fills_enabled boolean DEFAULT true NOT NULL,
    order_completed_enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_support_question_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_support_question_topics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    subcategory text DEFAULT '未分類'::text NOT NULL,
    CONSTRAINT telegram_support_question_topics_category_check CHECK ((category = ANY (ARRAY['認購／購買流程'::text, '二級市場／掛單成交'::text, 'AE／RWA 資產與標的'::text, '錢包／JC／USDT'::text, '登入／帳號／綁定'::text, '設定／登入／帳號'::text, '代理／分潤／獎金'::text, '費率／價格／手續費'::text, '網站操作／錯誤'::text, '其他'::text])))
);


--
-- Name: COLUMN telegram_support_question_topics.subcategory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.telegram_support_question_topics.subcategory IS 'AI-generated support question subcategory label; legacy rows remain 未分類 because the question text is not stored.';


--
-- Name: telegram_user_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_user_links (
    user_id uuid NOT NULL,
    chat_id text NOT NULL,
    telegram_username text,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_announcement_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_announcement_reads (
    user_id uuid NOT NULL,
    announcement_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    language text DEFAULT 'zh-TW'::text NOT NULL,
    color_mode text DEFAULT 'dark'::text NOT NULL,
    accent_hue smallint DEFAULT 43 NOT NULL,
    accent_saturation smallint DEFAULT 96 NOT NULL,
    accent_lightness smallint DEFAULT 56 NOT NULL,
    browser_push_enabled boolean DEFAULT true NOT NULL,
    price_alerts_enabled boolean DEFAULT true NOT NULL,
    dividend_alerts_enabled boolean DEFAULT true NOT NULL,
    listings_alerts_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_preferences_accent_hue_check CHECK (((accent_hue >= 0) AND (accent_hue <= 360))),
    CONSTRAINT user_preferences_accent_lightness_check CHECK (((accent_lightness >= 30) AND (accent_lightness <= 75))),
    CONSTRAINT user_preferences_accent_saturation_check CHECK (((accent_saturation >= 20) AND (accent_saturation <= 100))),
    CONSTRAINT user_preferences_color_mode_check CHECK ((color_mode = ANY (ARRAY['dark'::text, 'light'::text, 'system'::text]))),
    CONSTRAINT user_preferences_language_check CHECK ((language = ANY (ARRAY['zh-TW'::text, 'zh-CN'::text, 'en'::text, 'ja'::text, 'ko'::text, 'th'::text, 'vi'::text, 'id'::text, 'ms'::text, 'es'::text, 'fr'::text, 'de'::text, 'pt'::text, 'ru'::text, 'ar'::text, 'hi'::text])))
);


--
-- Name: rwmt_town_opens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_opens ALTER COLUMN id SET DEFAULT nextval('public.rwmt_town_opens_id_seq'::regclass);


--
-- Name: rwmt_town_rounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_rounds ALTER COLUMN id SET DEFAULT nextval('public.rwmt_town_rounds_id_seq'::regclass);


--
-- Name: admin_audit_logs admin_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: agency_applications agency_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_applications
    ADD CONSTRAINT agency_applications_pkey PRIMARY KEY (id);


--
-- Name: asset_ledger asset_ledger_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_ledger
    ADD CONSTRAINT asset_ledger_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: asset_ledger asset_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_ledger
    ADD CONSTRAINT asset_ledger_pkey PRIMARY KEY (id);


--
-- Name: automation_state automation_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_state
    ADD CONSTRAINT automation_state_pkey PRIMARY KEY (key);


--
-- Name: background_push_logs background_push_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_push_logs
    ADD CONSTRAINT background_push_logs_pkey PRIMARY KEY (id);


--
-- Name: commission_logs commission_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_pkey PRIMARY KEY (id);


--
-- Name: commission_payout_batches commission_payout_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payout_batches
    ADD CONSTRAINT commission_payout_batches_pkey PRIMARY KEY (id);


--
-- Name: commission_processing_errors commission_processing_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_processing_errors
    ADD CONSTRAINT commission_processing_errors_pkey PRIMARY KEY (id);


--
-- Name: commission_processing_errors commission_processing_errors_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_processing_errors
    ADD CONSTRAINT commission_processing_errors_request_key_key UNIQUE (request_key);


--
-- Name: commission_settings commission_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_settings
    ADD CONSTRAINT commission_settings_pkey PRIMARY KEY (agency_role, asset_mode);


--
-- Name: commission_logs commission_source_beneficiary_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_source_beneficiary_unique UNIQUE (source_ledger_id, beneficiary_id);


--
-- Name: commission_user_overrides commission_user_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_user_overrides
    ADD CONSTRAINT commission_user_overrides_pkey PRIMARY KEY (user_id, asset_mode);


--
-- Name: holdings holdings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings
    ADD CONSTRAINT holdings_pkey PRIMARY KEY (user_id, asset_id);


--
-- Name: jc_ledger jc_ledger_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jc_ledger
    ADD CONSTRAINT jc_ledger_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: jc_ledger jc_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jc_ledger
    ADD CONSTRAINT jc_ledger_pkey PRIMARY KEY (id);


--
-- Name: market_price_snapshots market_price_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_price_snapshots
    ADD CONSTRAINT market_price_snapshots_pkey PRIMARY KEY (id);


--
-- Name: onchain_settlements onchain_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onchain_settlements
    ADD CONSTRAINT onchain_settlements_pkey PRIMARY KEY (id);


--
-- Name: onchain_settlements onchain_settlements_ref_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onchain_settlements
    ADD CONSTRAINT onchain_settlements_ref_key_key UNIQUE (ref_key);


--
-- Name: p2p_escrow_cutover_audit p2p_escrow_cutover_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_cutover_audit
    ADD CONSTRAINT p2p_escrow_cutover_audit_pkey PRIMARY KEY (order_id);


--
-- Name: p2p_escrow_events p2p_escrow_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_events
    ADD CONSTRAINT p2p_escrow_events_pkey PRIMARY KEY (tx_hash);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_pkey PRIMARY KEY (fill_key);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_tx_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_tx_hash_key UNIQUE (tx_hash);


--
-- Name: p2p_escrow_order_reservations p2p_escrow_order_reservations_client_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_order_reservations
    ADD CONSTRAINT p2p_escrow_order_reservations_client_order_id_key UNIQUE (client_order_id);


--
-- Name: p2p_escrow_order_reservations p2p_escrow_order_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_order_reservations
    ADD CONSTRAINT p2p_escrow_order_reservations_pkey PRIMARY KEY (request_key);


--
-- Name: p2p_orders p2p_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_orders
    ADD CONSTRAINT p2p_orders_pkey PRIMARY KEY (id);


--
-- Name: platform_announcements platform_announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_announcements
    ADD CONSTRAINT platform_announcements_pkey PRIMARY KEY (id);


--
-- Name: platform_config platform_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_pkey PRIMARY KEY (id);


--
-- Name: platform_fee_ledger platform_fee_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_ledger
    ADD CONSTRAINT platform_fee_ledger_pkey PRIMARY KEY (id);


--
-- Name: platform_fee_ledger platform_fee_ledger_source_type_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_ledger
    ADD CONSTRAINT platform_fee_ledger_source_type_source_id_key UNIQUE (source_type, source_id);


--
-- Name: private_placements private_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_placements
    ADD CONSTRAINT private_placements_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: redemption_orders redemption_orders_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemption_orders
    ADD CONSTRAINT redemption_orders_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: redemption_orders redemption_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemption_orders
    ADD CONSTRAINT redemption_orders_pkey PRIMARY KEY (id);


--
-- Name: referral_binding_logs referral_binding_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_pkey PRIMARY KEY (id);


--
-- Name: rwa_placement_escrows rwa_placement_escrows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwa_placement_escrows
    ADD CONSTRAINT rwa_placement_escrows_pkey PRIMARY KEY (id);


--
-- Name: rwa_placement_escrows rwa_placement_escrows_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwa_placement_escrows
    ADD CONSTRAINT rwa_placement_escrows_request_key_key UNIQUE (request_key);


--
-- Name: rwmt_town_opens rwmt_town_opens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_opens
    ADD CONSTRAINT rwmt_town_opens_pkey PRIMARY KEY (id);


--
-- Name: rwmt_town_opens rwmt_town_opens_round_id_user_id_house_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_opens
    ADD CONSTRAINT rwmt_town_opens_round_id_user_id_house_index_key UNIQUE (round_id, user_id, house_index);


--
-- Name: rwmt_town_rounds rwmt_town_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_rounds
    ADD CONSTRAINT rwmt_town_rounds_pkey PRIMARY KEY (id);


--
-- Name: safe_proposals safe_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safe_proposals
    ADD CONSTRAINT safe_proposals_pkey PRIMARY KEY (id);


--
-- Name: settlement_reservations settlement_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_reservations
    ADD CONSTRAINT settlement_reservations_pkey PRIMARY KEY (request_key);


--
-- Name: site_visual_effects site_visual_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_visual_effects
    ADD CONSTRAINT site_visual_effects_pkey PRIMARY KEY (id);


--
-- Name: system_monitor_events system_monitor_events_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_monitor_events
    ADD CONSTRAINT system_monitor_events_event_key_key UNIQUE (event_key);


--
-- Name: system_monitor_events system_monitor_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_monitor_events
    ADD CONSTRAINT system_monitor_events_pkey PRIMARY KEY (id);


--
-- Name: system_monitor_state system_monitor_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_monitor_state
    ADD CONSTRAINT system_monitor_state_pkey PRIMARY KEY (key);


--
-- Name: telegram_delivery_logs telegram_delivery_logs_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_delivery_logs
    ADD CONSTRAINT telegram_delivery_logs_event_key_key UNIQUE (event_key);


--
-- Name: telegram_delivery_logs telegram_delivery_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_delivery_logs
    ADD CONSTRAINT telegram_delivery_logs_pkey PRIMARY KEY (id);


--
-- Name: telegram_link_tokens telegram_link_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_link_tokens
    ADD CONSTRAINT telegram_link_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: telegram_notification_preferences telegram_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_notification_preferences
    ADD CONSTRAINT telegram_notification_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: telegram_support_question_topics telegram_support_question_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_support_question_topics
    ADD CONSTRAINT telegram_support_question_topics_pkey PRIMARY KEY (id);


--
-- Name: telegram_user_links telegram_user_links_chat_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_chat_id_key UNIQUE (chat_id);


--
-- Name: telegram_user_links telegram_user_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_pkey PRIMARY KEY (user_id);


--
-- Name: user_announcement_reads user_announcement_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_announcement_reads
    ADD CONSTRAINT user_announcement_reads_pkey PRIMARY KEY (user_id, announcement_id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: agency_one_pending_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agency_one_pending_per_user ON public.agency_applications USING btree (user_id) WHERE (status = 'pending'::text);


--
-- Name: asset_ledger_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_ledger_user_created_idx ON public.asset_ledger USING btree (user_id, created_at DESC);


--
-- Name: audit_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_created_idx ON public.admin_audit_logs USING btree (created_at DESC);


--
-- Name: background_push_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX background_push_logs_created_at_idx ON public.background_push_logs USING btree (created_at DESC);


--
-- Name: commission_agent_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commission_agent_created_idx ON public.commission_logs USING btree (agent_id, created_at DESC);


--
-- Name: commission_logs_beneficiary_bonus_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commission_logs_beneficiary_bonus_type_idx ON public.commission_logs USING btree (beneficiary_id, bonus_type, created_at);


--
-- Name: jc_ledger_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jc_ledger_asset_idx ON public.jc_ledger USING btree (asset_id);


--
-- Name: jc_ledger_commission_pending_bonus_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jc_ledger_commission_pending_bonus_type_idx ON public.jc_ledger USING btree (((metadata ->> 'bonus_type'::text)), user_id, created_at) WHERE (entry_type = 'commission_pending'::text);


--
-- Name: jc_ledger_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jc_ledger_user_idx ON public.jc_ledger USING btree (user_id);


--
-- Name: market_price_snapshots_asset_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX market_price_snapshots_asset_time_idx ON public.market_price_snapshots USING btree (asset_id, recorded_at);


--
-- Name: onchain_settlements_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX onchain_settlements_action_idx ON public.onchain_settlements USING btree (action);


--
-- Name: onchain_settlements_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX onchain_settlements_user_idx ON public.onchain_settlements USING btree (user_id);


--
-- Name: p2p_escrow_auto_match_book_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX p2p_escrow_auto_match_book_idx ON public.p2p_orders USING btree (asset_id, side, price, created_at) WHERE ((escrow_mode = 'escrow'::text) AND (status = ANY (ARRAY['open'::text, 'partially_filled'::text])));


--
-- Name: p2p_escrow_fills_counter_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX p2p_escrow_fills_counter_order_idx ON public.p2p_escrow_fills USING btree (counter_order_id) WHERE (counter_order_id IS NOT NULL);


--
-- Name: p2p_orders_book_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX p2p_orders_book_idx ON public.p2p_orders USING btree (asset_id, side, status, price, created_at);


--
-- Name: p2p_orders_escrow_contract_chain_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX p2p_orders_escrow_contract_chain_id_uidx ON public.p2p_orders USING btree (escrow_contract_address, escrow_chain_order_id) WHERE ((escrow_contract_address IS NOT NULL) AND (escrow_chain_order_id IS NOT NULL));


--
-- Name: p2p_orders_escrow_request_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX p2p_orders_escrow_request_uidx ON public.p2p_orders USING btree (escrow_request_key) WHERE (escrow_request_key IS NOT NULL);


--
-- Name: p2p_orders_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX p2p_orders_owner_idx ON public.p2p_orders USING btree (user_id, created_at DESC);


--
-- Name: platform_fee_ledger_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX platform_fee_ledger_created_idx ON public.platform_fee_ledger USING btree (created_at DESC);


--
-- Name: private_placements_is_delisted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX private_placements_is_delisted_idx ON public.private_placements USING btree (is_delisted);


--
-- Name: profiles_nickname_unique_ci_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_nickname_unique_ci_idx ON public.profiles USING btree (lower(btrim(nickname))) WHERE (NULLIF(btrim(nickname), ''::text) IS NOT NULL);


--
-- Name: profiles_privy_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_privy_id_key ON public.profiles USING btree (privy_id) WHERE (privy_id IS NOT NULL);


--
-- Name: profiles_promo_code_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_promo_code_unique ON public.profiles USING btree (upper(promo_code)) WHERE (promo_code IS NOT NULL);


--
-- Name: profiles_special_promo_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_special_promo_code_idx ON public.profiles USING btree (special_promo_code);


--
-- Name: push_subscriptions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions USING btree (user_id);


--
-- Name: redemption_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX redemption_orders_status_idx ON public.redemption_orders USING btree (status);


--
-- Name: redemption_orders_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX redemption_orders_user_id_idx ON public.redemption_orders USING btree (user_id);


--
-- Name: rwa_escrows_asset_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rwa_escrows_asset_status_idx ON public.rwa_placement_escrows USING btree (asset_id, status);


--
-- Name: rwa_escrows_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rwa_escrows_user_status_idx ON public.rwa_placement_escrows USING btree (user_id, status);


--
-- Name: rwmt_town_opens_round_house; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rwmt_town_opens_round_house ON public.rwmt_town_opens USING btree (round_id, house_index);


--
-- Name: rwmt_town_rounds_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rwmt_town_rounds_one_active ON public.rwmt_town_rounds USING btree (status) WHERE (status = 'active'::text);


--
-- Name: safe_proposals_active_nonce_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX safe_proposals_active_nonce_uidx ON public.safe_proposals USING btree (safe_address, safe_nonce) WHERE (status = ANY (ARRAY['pending'::text, 'executing'::text]));


--
-- Name: safe_proposals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX safe_proposals_status_idx ON public.safe_proposals USING btree (status, created_at DESC);


--
-- Name: settlement_reservations_pending_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlement_reservations_pending_asset_idx ON public.settlement_reservations USING btree (asset_id, status, created_at) WHERE ((action = 'subscribe'::text) AND (status = 'pending'::text));


--
-- Name: settlement_reservations_pending_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX settlement_reservations_pending_user_idx ON public.settlement_reservations USING btree (user_id, action, status, created_at DESC);


--
-- Name: settlement_reservations_source_tx_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX settlement_reservations_source_tx_hash_key ON public.settlement_reservations USING btree (source_tx_hash) WHERE (source_tx_hash IS NOT NULL);


--
-- Name: system_monitor_events_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_monitor_events_status_created_idx ON public.system_monitor_events USING btree (status, created_at DESC);


--
-- Name: telegram_delivery_logs_admin_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_delivery_logs_admin_created_idx ON public.telegram_delivery_logs USING btree (sent_by, created_at DESC) WHERE (category = 'admin_direct'::text);


--
-- Name: telegram_delivery_logs_target_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_delivery_logs_target_created_idx ON public.telegram_delivery_logs USING btree (target_user_id, created_at DESC);


--
-- Name: telegram_link_tokens_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_link_tokens_user_created_idx ON public.telegram_link_tokens USING btree (user_id, created_at DESC);


--
-- Name: telegram_support_question_topics_asked_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_support_question_topics_asked_at_idx ON public.telegram_support_question_topics USING btree (asked_at);


--
-- Name: user_preferences_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_preferences_updated_at_idx ON public.user_preferences USING btree (updated_at);


--
-- Name: asset_ledger asset_ledger_price_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER asset_ledger_price_lock BEFORE INSERT ON public.asset_ledger FOR EACH ROW EXECUTE FUNCTION private.block_secondary_orders_during_price_lock();


--
-- Name: commission_logs commission_logs_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER commission_logs_guard BEFORE INSERT ON public.commission_logs FOR EACH ROW EXECUTE FUNCTION private.guard_commission_log();


--
-- Name: profiles ensure_genesis_l0_profile; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ensure_genesis_l0_profile AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.ensure_genesis_l0_profile();


--
-- Name: asset_ledger guard_asset_market_phase; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_asset_market_phase BEFORE INSERT ON public.asset_ledger FOR EACH ROW EXECUTE FUNCTION private.guard_asset_market_phase();


--
-- Name: profiles guard_profile_privilege_changes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_profile_privilege_changes BEFORE UPDATE OF agency_role, role, referrer_id, parent_id, master_agent_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.guard_profile_privilege_changes();


--
-- Name: jc_ledger jc_ledger_guard_settlement_reservations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER jc_ledger_guard_settlement_reservations BEFORE INSERT OR UPDATE OF amount, user_id ON public.jc_ledger FOR EACH ROW EXECUTE FUNCTION private.guard_jc_reservation_debit();


--
-- Name: profiles normalize_special_promo_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER normalize_special_promo_code BEFORE INSERT OR UPDATE OF special_promo_code ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.normalize_special_promo_code();


--
-- Name: user_preferences set_user_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_user_preferences_updated_at BEFORE UPDATE ON public.user_preferences FOR EACH ROW EXECUTE FUNCTION public.set_user_preferences_updated_at();


--
-- Name: private_placements sync_private_placement_market_state; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_private_placement_market_state BEFORE INSERT OR UPDATE OF available, is_active, ends_at, market_started_at ON public.private_placements FOR EACH ROW EXECUTE FUNCTION private.sync_private_placement_market_state();


--
-- Name: telegram_notification_preferences telegram_notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER telegram_notification_preferences_updated_at BEFORE UPDATE ON public.telegram_notification_preferences FOR EACH ROW EXECUTE FUNCTION public.touch_telegram_notification_preferences_updated_at();


--
-- Name: admin_audit_logs admin_audit_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_logs
    ADD CONSTRAINT admin_audit_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.profiles(id);


--
-- Name: agency_applications agency_applications_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_applications
    ADD CONSTRAINT agency_applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id);


--
-- Name: agency_applications agency_applications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agency_applications
    ADD CONSTRAINT agency_applications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: asset_ledger asset_ledger_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_ledger
    ADD CONSTRAINT asset_ledger_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: asset_ledger asset_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_ledger
    ADD CONSTRAINT asset_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: background_push_logs background_push_logs_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_push_logs
    ADD CONSTRAINT background_push_logs_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: commission_logs commission_logs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.profiles(id);


--
-- Name: commission_logs commission_logs_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: commission_logs commission_logs_beneficiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_beneficiary_id_fkey FOREIGN KEY (beneficiary_id) REFERENCES public.profiles(id);


--
-- Name: commission_logs commission_logs_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.profiles(id);


--
-- Name: commission_logs commission_logs_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES public.jc_ledger(id);


--
-- Name: commission_logs commission_logs_payout_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_payout_batch_id_fkey FOREIGN KEY (payout_batch_id) REFERENCES public.commission_payout_batches(id);


--
-- Name: commission_logs commission_logs_source_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_source_agent_id_fkey FOREIGN KEY (source_agent_id) REFERENCES public.profiles(id);


--
-- Name: commission_logs commission_logs_source_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_source_ledger_id_fkey FOREIGN KEY (source_ledger_id) REFERENCES public.jc_ledger(id);


--
-- Name: commission_logs commission_logs_source_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_logs
    ADD CONSTRAINT commission_logs_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES public.profiles(id);


--
-- Name: commission_payout_batches commission_payout_batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_payout_batches
    ADD CONSTRAINT commission_payout_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: commission_processing_errors commission_processing_errors_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_processing_errors
    ADD CONSTRAINT commission_processing_errors_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id) ON DELETE SET NULL;


--
-- Name: commission_processing_errors commission_processing_errors_source_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_processing_errors
    ADD CONSTRAINT commission_processing_errors_source_ledger_id_fkey FOREIGN KEY (source_ledger_id) REFERENCES public.asset_ledger(id) ON DELETE SET NULL;


--
-- Name: commission_processing_errors commission_processing_errors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_processing_errors
    ADD CONSTRAINT commission_processing_errors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: commission_user_overrides commission_user_overrides_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_user_overrides
    ADD CONSTRAINT commission_user_overrides_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: commission_user_overrides commission_user_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_user_overrides
    ADD CONSTRAINT commission_user_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: holdings holdings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings
    ADD CONSTRAINT holdings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: jc_ledger jc_ledger_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jc_ledger
    ADD CONSTRAINT jc_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: market_price_snapshots market_price_snapshots_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_price_snapshots
    ADD CONSTRAINT market_price_snapshots_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id) ON DELETE CASCADE;


--
-- Name: market_price_snapshots market_price_snapshots_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_price_snapshots
    ADD CONSTRAINT market_price_snapshots_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: onchain_settlements onchain_settlements_counterparty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onchain_settlements
    ADD CONSTRAINT onchain_settlements_counterparty_id_fkey FOREIGN KEY (counterparty_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: onchain_settlements onchain_settlements_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onchain_settlements
    ADD CONSTRAINT onchain_settlements_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: p2p_escrow_events p2p_escrow_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_events
    ADD CONSTRAINT p2p_escrow_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: p2p_escrow_fills p2p_escrow_fills_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.profiles(id);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_counter_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_counter_order_id_fkey FOREIGN KEY (counter_order_id) REFERENCES public.p2p_orders(id);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.p2p_orders(id);


--
-- Name: p2p_escrow_fills p2p_escrow_fills_seller_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_fills
    ADD CONSTRAINT p2p_escrow_fills_seller_id_fkey FOREIGN KEY (seller_id) REFERENCES public.profiles(id);


--
-- Name: p2p_escrow_order_reservations p2p_escrow_order_reservations_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_order_reservations
    ADD CONSTRAINT p2p_escrow_order_reservations_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: p2p_escrow_order_reservations p2p_escrow_order_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_escrow_order_reservations
    ADD CONSTRAINT p2p_escrow_order_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: p2p_orders p2p_orders_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_orders
    ADD CONSTRAINT p2p_orders_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: p2p_orders p2p_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.p2p_orders
    ADD CONSTRAINT p2p_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: platform_announcements platform_announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_announcements
    ADD CONSTRAINT platform_announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: platform_config platform_config_featured_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_featured_asset_id_fkey FOREIGN KEY (featured_asset_id) REFERENCES public.private_placements(id) ON DELETE SET NULL;


--
-- Name: platform_config platform_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: platform_fee_ledger platform_fee_ledger_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_ledger
    ADD CONSTRAINT platform_fee_ledger_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id);


--
-- Name: platform_fee_ledger platform_fee_ledger_payer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_fee_ledger
    ADD CONSTRAINT platform_fee_ledger_payer_id_fkey FOREIGN KEY (payer_id) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_master_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_master_agent_id_fkey FOREIGN KEY (master_agent_id) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.profiles(id);


--
-- Name: profiles profiles_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.profiles(id);


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: redemption_orders redemption_orders_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemption_orders
    ADD CONSTRAINT redemption_orders_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.profiles(id);


--
-- Name: redemption_orders redemption_orders_jc_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemption_orders
    ADD CONSTRAINT redemption_orders_jc_ledger_id_fkey FOREIGN KEY (jc_ledger_id) REFERENCES public.jc_ledger(id);


--
-- Name: redemption_orders redemption_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemption_orders
    ADD CONSTRAINT redemption_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: referral_binding_logs referral_binding_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);


--
-- Name: referral_binding_logs referral_binding_logs_new_master_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_new_master_agent_id_fkey FOREIGN KEY (new_master_agent_id) REFERENCES public.profiles(id);


--
-- Name: referral_binding_logs referral_binding_logs_new_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_new_referrer_id_fkey FOREIGN KEY (new_referrer_id) REFERENCES public.profiles(id);


--
-- Name: referral_binding_logs referral_binding_logs_old_master_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_old_master_agent_id_fkey FOREIGN KEY (old_master_agent_id) REFERENCES public.profiles(id);


--
-- Name: referral_binding_logs referral_binding_logs_old_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_old_referrer_id_fkey FOREIGN KEY (old_referrer_id) REFERENCES public.profiles(id);


--
-- Name: referral_binding_logs referral_binding_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_binding_logs
    ADD CONSTRAINT referral_binding_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);


--
-- Name: rwa_placement_escrows rwa_placement_escrows_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwa_placement_escrows
    ADD CONSTRAINT rwa_placement_escrows_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.private_placements(id) ON DELETE CASCADE;


--
-- Name: rwa_placement_escrows rwa_placement_escrows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwa_placement_escrows
    ADD CONSTRAINT rwa_placement_escrows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: rwmt_town_opens rwmt_town_opens_round_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_opens
    ADD CONSTRAINT rwmt_town_opens_round_id_fkey FOREIGN KEY (round_id) REFERENCES public.rwmt_town_rounds(id) ON DELETE CASCADE;


--
-- Name: rwmt_town_opens rwmt_town_opens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rwmt_town_opens
    ADD CONSTRAINT rwmt_town_opens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: safe_proposals safe_proposals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safe_proposals
    ADD CONSTRAINT safe_proposals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: settlement_reservations settlement_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_reservations
    ADD CONSTRAINT settlement_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: telegram_delivery_logs telegram_delivery_logs_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_delivery_logs
    ADD CONSTRAINT telegram_delivery_logs_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: telegram_delivery_logs telegram_delivery_logs_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_delivery_logs
    ADD CONSTRAINT telegram_delivery_logs_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: telegram_link_tokens telegram_link_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_link_tokens
    ADD CONSTRAINT telegram_link_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: telegram_notification_preferences telegram_notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_notification_preferences
    ADD CONSTRAINT telegram_notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: telegram_user_links telegram_user_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_user_links
    ADD CONSTRAINT telegram_user_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_announcement_reads user_announcement_reads_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_announcement_reads
    ADD CONSTRAINT user_announcement_reads_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.platform_announcements(id) ON DELETE CASCADE;


--
-- Name: user_announcement_reads user_announcement_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_announcement_reads
    ADD CONSTRAINT user_announcement_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles Public Profiles Access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public Profiles Access" ON public.profiles FOR SELECT USING (true);


--
-- Name: profiles User Update Self Profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "User Update Self Profile" ON public.profiles FOR UPDATE USING ((auth.uid() = id));


--
-- Name: asset_ledger Users can view own ledger; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own ledger" ON public.asset_ledger FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: admin_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: agency_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agency_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: agency_applications agency_applications_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agency_applications_read ON public.agency_applications FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: platform_announcements announcements_read_active; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY announcements_read_active ON public.platform_announcements FOR SELECT TO authenticated USING ((is_active OR private.is_admin()));


--
-- Name: asset_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_audit_logs audits_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audits_admin_read ON public.admin_audit_logs FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: automation_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_state ENABLE ROW LEVEL SECURITY;

--
-- Name: background_push_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.background_push_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: background_push_logs background_push_logs_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY background_push_logs_admin_delete ON public.background_push_logs FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.agency_role = ANY (ARRAY['admin'::text, 'super_admin'::text, '管理員'::text]))))));


--
-- Name: background_push_logs background_push_logs_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY background_push_logs_admin_select ON public.background_push_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.agency_role = ANY (ARRAY['admin'::text, 'super_admin'::text, '管理員'::text]))))));


--
-- Name: commission_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_payout_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_payout_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_payout_batches commission_payout_batches_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_payout_batches_admin_read ON public.commission_payout_batches FOR SELECT TO authenticated USING (private.is_admin());


--
-- Name: commission_processing_errors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_processing_errors ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_processing_errors commission_processing_errors_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_processing_errors_admin_read ON public.commission_processing_errors FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: commission_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_settings commission_settings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commission_settings_read ON public.commission_settings FOR SELECT TO authenticated USING (true);


--
-- Name: commission_user_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commission_user_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: commission_logs commissions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY commissions_read ON public.commission_logs FOR SELECT TO authenticated USING (((agent_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: holdings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.holdings ENABLE ROW LEVEL SECURITY;

--
-- Name: holdings holdings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY holdings_read ON public.holdings FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: jc_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jc_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: jc_ledger jc_ledger_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY jc_ledger_select_admin ON public.jc_ledger FOR SELECT TO authenticated USING (( SELECT private.is_admin() AS is_admin));


--
-- Name: jc_ledger jc_ledger_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY jc_ledger_select_own ON public.jc_ledger FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: asset_ledger ledger_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ledger_read ON public.asset_ledger FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: market_price_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_price_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: onchain_settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.onchain_settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: onchain_settlements onchain_settlements_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY onchain_settlements_select_admin ON public.onchain_settlements FOR SELECT TO authenticated USING (private.is_admin());


--
-- Name: onchain_settlements onchain_settlements_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY onchain_settlements_select_own ON public.onchain_settlements FOR SELECT TO authenticated USING (((auth.uid() = user_id) OR (auth.uid() = counterparty_id)));


--
-- Name: p2p_escrow_cutover_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.p2p_escrow_cutover_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: p2p_escrow_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.p2p_escrow_events ENABLE ROW LEVEL SECURITY;

--
-- Name: p2p_escrow_fills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.p2p_escrow_fills ENABLE ROW LEVEL SECURITY;

--
-- Name: p2p_escrow_order_reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.p2p_escrow_order_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: p2p_escrow_order_reservations p2p_escrow_reservations_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p2p_escrow_reservations_read_own ON public.p2p_escrow_order_reservations FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: p2p_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.p2p_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: private_placements placements_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY placements_read ON public.private_placements FOR SELECT TO authenticated USING (true);


--
-- Name: platform_announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config platform_config_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_config_read ON public.platform_config FOR SELECT TO authenticated USING (true);


--
-- Name: platform_fee_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_fee_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: private_placements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.private_placements ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_select_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own_or_admin ON public.profiles FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = id) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: profiles profiles_update_own_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own_or_admin ON public.profiles FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = id) OR ( SELECT private.is_admin() AS is_admin))) WITH CHECK (((( SELECT auth.uid() AS uid) = id) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions push_subscriptions_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions FOR DELETE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: push_subscriptions push_subscriptions_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subscriptions_insert_own ON public.push_subscriptions FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: push_subscriptions push_subscriptions_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: push_subscriptions push_subscriptions_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY push_subscriptions_update_own ON public.push_subscriptions FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: redemption_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.redemption_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: redemption_orders redemption_orders_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY redemption_orders_select_own ON public.redemption_orders FOR SELECT USING (((auth.uid() = user_id) OR private.is_admin()));


--
-- Name: referral_binding_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referral_binding_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: referral_binding_logs referral_logs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY referral_logs_read ON public.referral_binding_logs FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR (actor_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin)));


--
-- Name: rwa_placement_escrows rwa_escrows_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rwa_escrows_select_own ON public.rwa_placement_escrows FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: rwa_placement_escrows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rwa_placement_escrows ENABLE ROW LEVEL SECURITY;

--
-- Name: rwmt_town_opens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rwmt_town_opens ENABLE ROW LEVEL SECURITY;

--
-- Name: rwmt_town_rounds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rwmt_town_rounds ENABLE ROW LEVEL SECURITY;

--
-- Name: safe_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.safe_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settlement_reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_reservations settlement_reservations_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settlement_reservations_select_own ON public.settlement_reservations FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: site_visual_effects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_visual_effects ENABLE ROW LEVEL SECURITY;

--
-- Name: site_visual_effects site_visual_effects_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY site_visual_effects_public_read ON public.site_visual_effects FOR SELECT TO authenticated, anon USING (true);


--
-- Name: system_monitor_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_monitor_events ENABLE ROW LEVEL SECURITY;

--
-- Name: system_monitor_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_monitor_state ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_delivery_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_delivery_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_link_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_link_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_support_question_topics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_support_question_topics ENABLE ROW LEVEL SECURITY;

--
-- Name: telegram_user_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telegram_user_links ENABLE ROW LEVEL SECURITY;

--
-- Name: user_announcement_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_announcement_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: user_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: user_preferences user_preferences_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_preferences_insert_own ON public.user_preferences FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_preferences user_preferences_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_preferences_select_own ON public.user_preferences FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_preferences user_preferences_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_preferences_update_own ON public.user_preferences FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_announcement_reads users_insert_own_announcement_reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_insert_own_announcement_reads ON public.user_announcement_reads FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_announcement_reads users_read_own_announcement_reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_read_own_announcement_reads ON public.user_announcement_reads FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: SCHEMA private; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA private TO authenticated;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION agent_six_month_boost(agent_id uuid, month_start date); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.agent_six_month_boost(agent_id uuid, month_start date) FROM PUBLIC;


--
-- Name: FUNCTION block_secondary_orders_during_price_lock(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.block_secondary_orders_during_price_lock() FROM PUBLIC;


--
-- Name: FUNCTION escrow_event_contract(p_event jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.escrow_event_contract(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION private.escrow_event_contract(p_event jsonb) TO service_role;


--
-- Name: FUNCTION generate_promo_code(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.generate_promo_code() FROM PUBLIC;


--
-- Name: FUNCTION guard_jc_reservation_debit(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.guard_jc_reservation_debit() FROM PUBLIC;


--
-- Name: FUNCTION guard_profile_privilege_changes(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.guard_profile_privilege_changes() FROM PUBLIC;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION private.is_admin() TO authenticated;
GRANT ALL ON FUNCTION private.is_admin() TO service_role;


--
-- Name: FUNCTION is_effective_member(target_user uuid, month_start date); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.is_effective_member(target_user uuid, month_start date) FROM PUBLIC;


--
-- Name: FUNCTION master_month_boost(master_id uuid, month_start date); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.master_month_boost(master_id uuid, month_start date) FROM PUBLIC;


--
-- Name: FUNCTION month_investment(target_user uuid, month_start date); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.month_investment(target_user uuid, month_start date) FROM PUBLIC;


--
-- Name: FUNCTION new_effective_count(owner_id uuid, month_start date, include_team boolean); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.new_effective_count(owner_id uuid, month_start date, include_team boolean) FROM PUBLIC;


--
-- Name: FUNCTION post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text) TO authenticated;


--
-- Name: FUNCTION resolve_commission_rate(p_kind text, p_slot text, p_beneficiary uuid, p_asset_mode text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.resolve_commission_rate(p_kind text, p_slot text, p_beneficiary uuid, p_asset_mode text) FROM PUBLIC;


--
-- Name: FUNCTION settle_p2p_match(maker_order_key uuid, taker_order_key uuid, match_quantity numeric, match_key text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.settle_p2p_match(maker_order_key uuid, taker_order_key uuid, match_quantity numeric, match_key text) FROM PUBLIC;


--
-- Name: FUNCTION settlement_reserved_jc(p_user_id uuid, p_except_request_key text); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.settlement_reserved_jc(p_user_id uuid, p_except_request_key text) FROM PUBLIC;


--
-- Name: FUNCTION validate_p2p_auto_match(p_event jsonb); Type: ACL; Schema: private; Owner: -
--

REVOKE ALL ON FUNCTION private.validate_p2p_auto_match(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION private.validate_p2p_auto_match(p_event jsonb) TO service_role;


--
-- Name: FUNCTION activate_special_promo_code(promo text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.activate_special_promo_code(promo text) TO anon;
GRANT ALL ON FUNCTION public.activate_special_promo_code(promo text) TO authenticated;
GRANT ALL ON FUNCTION public.activate_special_promo_code(promo text) TO service_role;


--
-- Name: FUNCTION admin_apply_asset_payout(p_ref_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_apply_asset_payout(p_ref_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_apply_asset_payout(p_ref_key text) TO service_role;


--
-- Name: FUNCTION admin_cap_rwa_placement_available(p_placement_id text, p_chain_quantity numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_cap_rwa_placement_available(p_placement_id text, p_chain_quantity numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_cap_rwa_placement_available(p_placement_id text, p_chain_quantity numeric) TO service_role;


--
-- Name: TABLE private_placements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.private_placements TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.private_placements TO authenticated;
GRANT ALL ON TABLE public.private_placements TO service_role;


--
-- Name: COLUMN private_placements.history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(history) ON TABLE public.private_placements TO anon;
GRANT SELECT(history) ON TABLE public.private_placements TO authenticated;


--
-- Name: COLUMN private_placements.comparables; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(comparables) ON TABLE public.private_placements TO anon;
GRANT SELECT(comparables) ON TABLE public.private_placements TO authenticated;


--
-- Name: COLUMN private_placements.advantages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(advantages) ON TABLE public.private_placements TO anon;
GRANT SELECT(advantages) ON TABLE public.private_placements TO authenticated;


--
-- Name: FUNCTION admin_change_secondary_price(asset_key text, new_price numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_change_secondary_price(asset_key text, new_price numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_change_secondary_price(asset_key text, new_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_change_secondary_price(asset_key text, new_price numeric) TO service_role;


--
-- Name: FUNCTION admin_commission_discrepancies(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_commission_discrepancies() TO anon;
GRANT ALL ON FUNCTION public.admin_commission_discrepancies() TO authenticated;
GRANT ALL ON FUNCTION public.admin_commission_discrepancies() TO service_role;


--
-- Name: FUNCTION admin_commission_rate_audit(p_since timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_commission_rate_audit(p_since timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_commission_rate_audit(p_since timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.admin_commission_rate_audit(p_since timestamp with time zone) TO service_role;


--
-- Name: FUNCTION admin_complete_redemption(order_id uuid, tx_hash text, note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_complete_redemption(order_id uuid, tx_hash text, note text) TO anon;
GRANT ALL ON FUNCTION public.admin_complete_redemption(order_id uuid, tx_hash text, note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_complete_redemption(order_id uuid, tx_hash text, note text) TO service_role;


--
-- Name: FUNCTION admin_create_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_create_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO anon;
GRANT ALL ON FUNCTION public.admin_create_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_create_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO service_role;


--
-- Name: FUNCTION admin_deactivate_placement(placement_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_deactivate_placement(placement_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_deactivate_placement(placement_id text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_deactivate_placement(placement_id text) TO service_role;


--
-- Name: FUNCTION admin_delete_announcement(announcement_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_delete_announcement(announcement_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_delete_announcement(announcement_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_announcement(announcement_id uuid) TO service_role;


--
-- Name: FUNCTION admin_delete_background_push_log(push_log_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_delete_background_push_log(push_log_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_delete_background_push_log(push_log_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_delete_background_push_log(push_log_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_background_push_log(push_log_id uuid) TO service_role;


--
-- Name: FUNCTION admin_end_ae_token_bonus_round(p_asset_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_end_ae_token_bonus_round(p_asset_id text) TO anon;
GRANT ALL ON FUNCTION public.admin_end_ae_token_bonus_round(p_asset_id text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_end_ae_token_bonus_round(p_asset_id text) TO service_role;


--
-- Name: FUNCTION admin_end_private_placement(placement_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_end_private_placement(placement_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_end_private_placement(placement_id text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_end_private_placement(placement_id text) TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: COLUMN profiles.display_name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(display_name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.wallet_address; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(wallet_address) ON TABLE public.profiles TO authenticated;


--
-- Name: FUNCTION admin_freeze_account(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_freeze_account(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_freeze_account(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_freeze_account(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_jc_balance(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_get_jc_balance(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_get_jc_balance(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_jc_balance(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_user_town_transactions(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_get_user_town_transactions(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_get_user_town_transactions(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_user_town_transactions(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_user_wallet_town_transactions(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_get_user_wallet_town_transactions(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_get_user_wallet_town_transactions(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_user_wallet_town_transactions(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_get_wallet_balance(target_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_get_wallet_balance(target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_get_wallet_balance(target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_wallet_balance(target_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_list_background_push_logs(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_list_background_push_logs() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_list_background_push_logs() TO anon;
GRANT ALL ON FUNCTION public.admin_list_background_push_logs() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_background_push_logs() TO service_role;


--
-- Name: FUNCTION admin_list_commission_people(asset_mode_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_list_commission_people(asset_mode_text text) TO anon;
GRANT ALL ON FUNCTION public.admin_list_commission_people(asset_mode_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_commission_people(asset_mode_text text) TO service_role;


--
-- Name: FUNCTION admin_list_platform_fees(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_list_platform_fees() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_list_platform_fees() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_platform_fees() TO service_role;


--
-- Name: FUNCTION admin_list_private_placements(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_list_private_placements() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_list_private_placements() TO anon;
GRANT ALL ON FUNCTION public.admin_list_private_placements() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_private_placements() TO service_role;


--
-- Name: FUNCTION admin_list_wallet_balances(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_list_wallet_balances() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_list_wallet_balances() TO authenticated;
GRANT ALL ON FUNCTION public.admin_list_wallet_balances() TO service_role;


--
-- Name: TABLE commission_payout_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_payout_batches TO anon;
GRANT ALL ON TABLE public.commission_payout_batches TO authenticated;
GRANT ALL ON TABLE public.commission_payout_batches TO service_role;


--
-- Name: FUNCTION admin_pay_pending_commissions(role_text text, recipient_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_pay_pending_commissions(role_text text, recipient_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_pay_pending_commissions(role_text text, recipient_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.admin_pay_pending_commissions(role_text text, recipient_ids uuid[]) TO service_role;


--
-- Name: TABLE platform_announcements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_announcements TO anon;
GRANT ALL ON TABLE public.platform_announcements TO authenticated;
GRANT ALL ON TABLE public.platform_announcements TO service_role;


--
-- Name: FUNCTION admin_publish_announcement(title_text text, content_text text, translations_json jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_publish_announcement(title_text text, content_text text, translations_json jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_publish_announcement(title_text text, content_text text, translations_json jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_publish_announcement(title_text text, content_text text, translations_json jsonb) TO service_role;


--
-- Name: FUNCTION admin_rebind_referral(target_user_id uuid, new_promo_code text, reason_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_rebind_referral(target_user_id uuid, new_promo_code text, reason_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_rebind_referral(target_user_id uuid, new_promo_code text, reason_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_rebind_referral(target_user_id uuid, new_promo_code text, reason_text text) TO service_role;


--
-- Name: FUNCTION admin_rebind_referral_by_email(target_email text, new_promo_code text, reason_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_rebind_referral_by_email(target_email text, new_promo_code text, reason_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_rebind_referral_by_email(target_email text, new_promo_code text, reason_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_rebind_referral_by_email(target_email text, new_promo_code text, reason_text text) TO service_role;


--
-- Name: FUNCTION admin_reclaim_account_funds(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reclaim_account_funds(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_reclaim_account_funds(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reclaim_account_funds(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_reconciliation_report(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_reconciliation_report() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_reconciliation_report() TO authenticated;
GRANT ALL ON FUNCTION public.admin_reconciliation_report() TO service_role;


--
-- Name: FUNCTION admin_reject_redemption(order_id uuid, note text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reject_redemption(order_id uuid, note text) TO anon;
GRANT ALL ON FUNCTION public.admin_reject_redemption(order_id uuid, note text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_reject_redemption(order_id uuid, note text) TO service_role;


--
-- Name: FUNCTION admin_reset_ae_token(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_reset_ae_token() TO anon;
GRANT ALL ON FUNCTION public.admin_reset_ae_token() TO authenticated;
GRANT ALL ON FUNCTION public.admin_reset_ae_token() TO service_role;


--
-- Name: FUNCTION admin_restore_whitelist(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_restore_whitelist(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.admin_restore_whitelist(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_restore_whitelist(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION admin_rwa_escrow_summary(placement_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_rwa_escrow_summary(placement_id text) TO anon;
GRANT ALL ON FUNCTION public.admin_rwa_escrow_summary(placement_id text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_rwa_escrow_summary(placement_id text) TO service_role;


--
-- Name: FUNCTION admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text) TO anon;
GRANT ALL ON FUNCTION public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text) TO service_role;


--
-- Name: FUNCTION admin_secondary_fee_attribution_rows(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_secondary_fee_attribution_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_secondary_fee_attribution_rows() TO anon;
GRANT ALL ON FUNCTION public.admin_secondary_fee_attribution_rows() TO authenticated;
GRANT ALL ON FUNCTION public.admin_secondary_fee_attribution_rows() TO service_role;


--
-- Name: FUNCTION admin_secondary_fee_rows(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_secondary_fee_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_secondary_fee_rows() TO anon;
GRANT ALL ON FUNCTION public.admin_secondary_fee_rows() TO authenticated;
GRANT ALL ON FUNCTION public.admin_secondary_fee_rows() TO service_role;


--
-- Name: FUNCTION admin_set_announcement_active(announcement_id uuid, active boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_announcement_active(announcement_id uuid, active boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_announcement_active(announcement_id uuid, active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_announcement_active(announcement_id uuid, active boolean) TO service_role;


--
-- Name: TABLE platform_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_config TO anon;
GRANT ALL ON TABLE public.platform_config TO authenticated;
GRANT ALL ON TABLE public.platform_config TO service_role;


--
-- Name: FUNCTION admin_set_featured_asset(asset_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_featured_asset(asset_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_featured_asset(asset_key text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_featured_asset(asset_key text) TO service_role;


--
-- Name: FUNCTION admin_set_jc_price(new_price numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_jc_price(new_price numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_jc_price(new_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_jc_price(new_price numeric) TO service_role;


--
-- Name: FUNCTION admin_set_jc_redeem_price(new_price numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_jc_redeem_price(new_price numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_jc_redeem_price(new_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_jc_redeem_price(new_price numeric) TO service_role;


--
-- Name: FUNCTION admin_set_maintenance_mode(p_enabled boolean, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_maintenance_mode(p_enabled boolean, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_maintenance_mode(p_enabled boolean, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_maintenance_mode(p_enabled boolean, p_reason text) TO service_role;


--
-- Name: FUNCTION admin_set_placement_factory_params(p_id text, p_token_name text, p_token_symbol text, p_token_decimals integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_set_placement_factory_params(p_id text, p_token_name text, p_token_symbol text, p_token_decimals integer) TO anon;
GRANT ALL ON FUNCTION public.admin_set_placement_factory_params(p_id text, p_token_name text, p_token_symbol text, p_token_decimals integer) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_placement_factory_params(p_id text, p_token_name text, p_token_symbol text, p_token_decimals integer) TO service_role;


--
-- Name: FUNCTION admin_set_placement_token_address(p_id text, p_token_address text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_set_placement_token_address(p_id text, p_token_address text) TO anon;
GRANT ALL ON FUNCTION public.admin_set_placement_token_address(p_id text, p_token_address text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_placement_token_address(p_id text, p_token_address text) TO service_role;


--
-- Name: FUNCTION admin_set_rwa_ae_settings(placement_id text, p_total_value numeric, p_total_shares numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_set_rwa_ae_settings(placement_id text, p_total_value numeric, p_total_shares numeric) TO anon;
GRANT ALL ON FUNCTION public.admin_set_rwa_ae_settings(placement_id text, p_total_value numeric, p_total_shares numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_rwa_ae_settings(placement_id text, p_total_value numeric, p_total_shares numeric) TO service_role;


--
-- Name: FUNCTION admin_set_rwmt_town_config(p_config jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_rwmt_town_config(p_config jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_rwmt_town_config(p_config jsonb) TO anon;
GRANT ALL ON FUNCTION public.admin_set_rwmt_town_config(p_config jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_rwmt_town_config(p_config jsonb) TO service_role;


--
-- Name: FUNCTION admin_set_user_role(target_user_id uuid, role_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_user_role(target_user_id uuid, role_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_user_role(target_user_id uuid, role_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_set_user_role(target_user_id uuid, role_text text) TO service_role;


--
-- Name: FUNCTION admin_settle_rwa_placement(asset_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_settle_rwa_placement(asset_key text) TO anon;
GRANT ALL ON FUNCTION public.admin_settle_rwa_placement(asset_key text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_settle_rwa_placement(asset_key text) TO service_role;


--
-- Name: FUNCTION admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone, p_bonus_normal_price numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone, p_bonus_normal_price numeric) TO anon;
GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone, p_bonus_normal_price numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_start_ae_token_bonus_round(p_price numeric, p_total_supply numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text, p_information text, p_image text, p_ends_at timestamp with time zone, p_bonus_normal_price numeric) TO service_role;


--
-- Name: FUNCTION admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean) TO anon;
GRANT ALL ON FUNCTION public.admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean) TO authenticated;
GRANT ALL ON FUNCTION public.admin_start_rwmt_town_round(p_theme text, p_night boolean, p_house_count integer, p_ae_total integer, p_bomb_total integer, p_bomb_jc numeric, p_force boolean) TO service_role;


--
-- Name: FUNCTION admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_sync_jc_chain_balance(p_user_id uuid, p_wallet text, p_chain_balance numeric) TO service_role;


--
-- Name: FUNCTION admin_update_commission_rate(role_text text, rate_percent numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_update_commission_rate(role_text text, rate_percent numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_commission_rate(role_text text, rate_percent numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_commission_rate(role_text text, rate_percent numeric) TO service_role;


--
-- Name: FUNCTION admin_update_commission_rates(role_text text, private_percent numeric, secondary_percent numeric, asset_mode_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_update_commission_rates(role_text text, private_percent numeric, secondary_percent numeric, asset_mode_text text) TO anon;
GRANT ALL ON FUNCTION public.admin_update_commission_rates(role_text text, private_percent numeric, secondary_percent numeric, asset_mode_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_commission_rates(role_text text, private_percent numeric, secondary_percent numeric, asset_mode_text text) TO service_role;


--
-- Name: FUNCTION admin_update_placement_apy(placement_id text, new_apy text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_update_placement_apy(placement_id text, new_apy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_placement_apy(placement_id text, new_apy text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_placement_apy(placement_id text, new_apy text) TO service_role;


--
-- Name: FUNCTION admin_update_placement_translations(p_id text, p_translations jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_update_placement_translations(p_id text, p_translations jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_placement_translations(p_id text, p_translations jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_placement_translations(p_id text, p_translations jsonb) TO service_role;


--
-- Name: FUNCTION admin_update_profile(target_id uuid, new_balance numeric, new_agency_role text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_update_profile(target_id uuid, new_balance numeric, new_agency_role text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_profile(target_id uuid, new_balance numeric, new_agency_role text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_profile(target_id uuid, new_balance numeric, new_agency_role text) TO service_role;


--
-- Name: TABLE site_visual_effects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.site_visual_effects TO anon;
GRANT ALL ON TABLE public.site_visual_effects TO authenticated;
GRANT ALL ON TABLE public.site_visual_effects TO service_role;


--
-- Name: FUNCTION admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric) TO anon;
GRANT ALL ON FUNCTION public.admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_site_visual_effects(p_enabled boolean, p_effect text, p_color text, p_intensity numeric) TO service_role;


--
-- Name: FUNCTION admin_update_user_commission(target_user_id uuid, new_self_private_rate numeric, new_l1_private_rate numeric, new_l2_private_rate numeric, new_secondary_rate numeric, new_self_secondary_rate numeric, new_l1_secondary_rate numeric, new_l2_secondary_rate numeric, asset_mode_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_update_user_commission(target_user_id uuid, new_self_private_rate numeric, new_l1_private_rate numeric, new_l2_private_rate numeric, new_secondary_rate numeric, new_self_secondary_rate numeric, new_l1_secondary_rate numeric, new_l2_secondary_rate numeric, asset_mode_text text) TO anon;
GRANT ALL ON FUNCTION public.admin_update_user_commission(target_user_id uuid, new_self_private_rate numeric, new_l1_private_rate numeric, new_l2_private_rate numeric, new_secondary_rate numeric, new_self_secondary_rate numeric, new_l1_secondary_rate numeric, new_l2_secondary_rate numeric, asset_mode_text text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_user_commission(target_user_id uuid, new_self_private_rate numeric, new_l1_private_rate numeric, new_l2_private_rate numeric, new_secondary_rate numeric, new_self_secondary_rate numeric, new_l1_secondary_rate numeric, new_l2_secondary_rate numeric, asset_mode_text text) TO service_role;


--
-- Name: FUNCTION admin_upsert_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_upsert_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO anon;
GRANT ALL ON FUNCTION public.admin_upsert_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_upsert_placement(p_id text, p_name text, p_location text, p_address text, p_images text[], p_price numeric, p_valuation numeric, p_total_supply numeric, p_available numeric, p_apy text, p_information text, p_translations jsonb, p_ends_at timestamp with time zone, p_history jsonb, p_comparables jsonb, p_advantages jsonb) TO service_role;


--
-- Name: FUNCTION bind_referral_code(promo text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bind_referral_code(promo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bind_referral_code(promo text) TO authenticated;
GRANT ALL ON FUNCTION public.bind_referral_code(promo text) TO service_role;


--
-- Name: FUNCTION cancel_p2p_order(order_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_p2p_order(order_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_p2p_order(order_key uuid) TO service_role;


--
-- Name: FUNCTION claim_sweep_slot(p_key text, p_min_interval_seconds integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_sweep_slot(p_key text, p_min_interval_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.claim_sweep_slot(p_key text, p_min_interval_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.claim_sweep_slot(p_key text, p_min_interval_seconds integer) TO service_role;


--
-- Name: FUNCTION complete_telegram_account_link(p_token_hash text, p_chat_id text, p_telegram_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_telegram_account_link(p_token_hash text, p_chat_id text, p_telegram_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_telegram_account_link(p_token_hash text, p_chat_id text, p_telegram_username text) TO service_role;


--
-- Name: FUNCTION confirm_p2p_escrow_order(p_user_id uuid, p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.confirm_p2p_escrow_order(p_user_id uuid, p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.confirm_p2p_escrow_order(p_user_id uuid, p_event jsonb) TO service_role;


--
-- Name: FUNCTION create_p2p_order(asset_key text, order_side text, order_price numeric, order_quantity numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_p2p_order(asset_key text, order_side text, order_price numeric, order_quantity numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_p2p_order(asset_key text, order_side text, order_price numeric, order_quantity numeric, request_key text) TO service_role;


--
-- Name: FUNCTION execute_private_purchase(asset_key text, trade_quantity numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.execute_private_purchase(asset_key text, trade_quantity numeric, request_key text) TO service_role;


--
-- Name: TABLE asset_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.asset_ledger TO authenticated;
GRANT ALL ON TABLE public.asset_ledger TO service_role;


--
-- Name: FUNCTION execute_sandbox_trade(asset_key text, trade_side text, trade_quantity numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.execute_sandbox_trade(asset_key text, trade_side text, trade_quantity numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.execute_sandbox_trade(asset_key text, trade_side text, trade_quantity numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.execute_sandbox_trade(asset_key text, trade_side text, trade_quantity numeric, request_key text) TO service_role;


--
-- Name: FUNCTION fill_p2p_order(order_key uuid, fill_quantity numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.fill_p2p_order(order_key uuid, fill_quantity numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fill_p2p_order(order_key uuid, fill_quantity numeric, request_key text) TO service_role;


--
-- Name: FUNCTION finalize_commission_payout(p_commission_id uuid, p_tx_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_commission_payout(p_commission_id uuid, p_tx_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_commission_payout(p_commission_id uuid, p_tx_hash text) TO service_role;


--
-- Name: FUNCTION finalize_jc_redemption(p_order_id uuid, p_jc_collect_tx text, p_usdt_tx text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_jc_redemption(p_order_id uuid, p_jc_collect_tx text, p_usdt_tx text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_jc_redemption(p_order_id uuid, p_jc_collect_tx text, p_usdt_tx text) TO service_role;


--
-- Name: FUNCTION finalize_p2p_escrow_auto_match(p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_p2p_escrow_auto_match(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_p2p_escrow_auto_match(p_event jsonb) TO service_role;


--
-- Name: FUNCTION finalize_p2p_escrow_cancel(p_user_id uuid, p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_p2p_escrow_cancel(p_user_id uuid, p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_p2p_escrow_cancel(p_user_id uuid, p_event jsonb) TO service_role;


--
-- Name: FUNCTION finalize_p2p_escrow_fill(p_event jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_p2p_escrow_fill(p_event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_p2p_escrow_fill(p_event jsonb) TO service_role;


--
-- Name: FUNCTION finalize_private_purchase(p_request_key text, p_jc_pull_tx text, p_jc_vault_tx text, p_asset_tx text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_private_purchase(p_request_key text, p_jc_pull_tx text, p_jc_vault_tx text, p_asset_tx text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_private_purchase(p_request_key text, p_jc_pull_tx text, p_jc_vault_tx text, p_asset_tx text) TO service_role;


--
-- Name: FUNCTION finalize_vault_jc_purchase(p_request_key text, p_mint_tx text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalize_vault_jc_purchase(p_request_key text, p_mint_tx text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalize_vault_jc_purchase(p_request_key text, p_mint_tx text) TO service_role;


--
-- Name: FUNCTION get_agent_dashboard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_agent_dashboard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_agent_dashboard() TO authenticated;
GRANT ALL ON FUNCTION public.get_agent_dashboard() TO service_role;


--
-- Name: FUNCTION get_all_agent_performance_members(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_all_agent_performance_members() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_all_agent_performance_members() TO anon;
GRANT ALL ON FUNCTION public.get_all_agent_performance_members() TO authenticated;
GRANT ALL ON FUNCTION public.get_all_agent_performance_members() TO service_role;


--
-- Name: FUNCTION get_asset_volumes(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_asset_volumes() TO anon;
GRANT ALL ON FUNCTION public.get_asset_volumes() TO authenticated;
GRANT ALL ON FUNCTION public.get_asset_volumes() TO service_role;


--
-- Name: FUNCTION get_maintenance_state(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_maintenance_state() TO anon;
GRANT ALL ON FUNCTION public.get_maintenance_state() TO authenticated;
GRANT ALL ON FUNCTION public.get_maintenance_state() TO service_role;


--
-- Name: FUNCTION get_market_price_snapshots(asset_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_market_price_snapshots(asset_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_market_price_snapshots(asset_key text) TO authenticated;
GRANT ALL ON FUNCTION public.get_market_price_snapshots(asset_key text) TO service_role;


--
-- Name: FUNCTION get_market_trade_volumes(asset_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_market_trade_volumes(asset_key text) TO anon;
GRANT ALL ON FUNCTION public.get_market_trade_volumes(asset_key text) TO authenticated;
GRANT ALL ON FUNCTION public.get_market_trade_volumes(asset_key text) TO service_role;


--
-- Name: FUNCTION get_my_jc_balance(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_my_jc_balance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_my_jc_balance() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_jc_balance() TO service_role;


--
-- Name: FUNCTION get_my_p2p_orders(p_escrow_contract_address text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_p2p_orders(p_escrow_contract_address text) TO anon;
GRANT ALL ON FUNCTION public.get_my_p2p_orders(p_escrow_contract_address text) TO authenticated;
GRANT ALL ON FUNCTION public.get_my_p2p_orders(p_escrow_contract_address text) TO service_role;


--
-- Name: FUNCTION get_my_rwmt_town_transactions(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_my_rwmt_town_transactions() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_my_rwmt_town_transactions() TO anon;
GRANT ALL ON FUNCTION public.get_my_rwmt_town_transactions() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_rwmt_town_transactions() TO service_role;


--
-- Name: FUNCTION get_my_wallet_balance(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_my_wallet_balance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_my_wallet_balance() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_wallet_balance() TO service_role;


--
-- Name: FUNCTION get_p2p_order_book(asset_key text, p_escrow_contract_address text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_p2p_order_book(asset_key text, p_escrow_contract_address text) TO anon;
GRANT ALL ON FUNCTION public.get_p2p_order_book(asset_key text, p_escrow_contract_address text) TO authenticated;
GRANT ALL ON FUNCTION public.get_p2p_order_book(asset_key text, p_escrow_contract_address text) TO service_role;


--
-- Name: FUNCTION get_rwmt_town_challenge(p_house integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_rwmt_town_challenge(p_house integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_rwmt_town_challenge(p_house integer) TO anon;
GRANT ALL ON FUNCTION public.get_rwmt_town_challenge(p_house integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_rwmt_town_challenge(p_house integer) TO service_role;


--
-- Name: FUNCTION get_rwmt_town_state(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_rwmt_town_state() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_rwmt_town_state() TO anon;
GRANT ALL ON FUNCTION public.get_rwmt_town_state() TO authenticated;
GRANT ALL ON FUNCTION public.get_rwmt_town_state() TO service_role;


--
-- Name: FUNCTION get_safe_vault_address(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_safe_vault_address() TO anon;
GRANT ALL ON FUNCTION public.get_safe_vault_address() TO authenticated;
GRANT ALL ON FUNCTION public.get_safe_vault_address() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION is_current_user_admin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_current_user_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_current_user_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_current_user_admin() TO service_role;


--
-- Name: FUNCTION list_visible_private_placements(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_visible_private_placements() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_visible_private_placements() TO anon;
GRANT ALL ON FUNCTION public.list_visible_private_placements() TO authenticated;
GRANT ALL ON FUNCTION public.list_visible_private_placements() TO service_role;


--
-- Name: FUNCTION my_available_ae(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.my_available_ae() TO anon;
GRANT ALL ON FUNCTION public.my_available_ae() TO authenticated;
GRANT ALL ON FUNCTION public.my_available_ae() TO service_role;


--
-- Name: FUNCTION my_encumbered_ae(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.my_encumbered_ae() TO anon;
GRANT ALL ON FUNCTION public.my_encumbered_ae() TO authenticated;
GRANT ALL ON FUNCTION public.my_encumbered_ae() TO service_role;


--
-- Name: FUNCTION process_commission(p_trader_id uuid, p_amount numeric, p_project_id text, p_market_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.process_commission(p_trader_id uuid, p_amount numeric, p_project_id text, p_market_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_commission(p_trader_id uuid, p_amount numeric, p_project_id text, p_market_type text) TO anon;
GRANT ALL ON FUNCTION public.process_commission(p_trader_id uuid, p_amount numeric, p_project_id text, p_market_type text) TO authenticated;
GRANT ALL ON FUNCTION public.process_commission(p_trader_id uuid, p_amount numeric, p_project_id text, p_market_type text) TO service_role;


--
-- Name: FUNCTION release_p2p_escrow_order_reservation(p_request_key uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_p2p_escrow_order_reservation(p_request_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_p2p_escrow_order_reservation(p_request_key uuid) TO authenticated;
GRANT ALL ON FUNCTION public.release_p2p_escrow_order_reservation(p_request_key uuid) TO service_role;


--
-- Name: FUNCTION release_unsubmitted_vault_jc_purchase(request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_unsubmitted_vault_jc_purchase(request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_unsubmitted_vault_jc_purchase(request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.release_unsubmitted_vault_jc_purchase(request_key text) TO service_role;


--
-- Name: FUNCTION request_jc_redemption(jc_amount numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text) TO service_role;


--
-- Name: FUNCTION reserve_p2p_escrow_order(p_asset_key text, p_side text, p_price numeric, p_quantity numeric, p_request_key uuid, p_client_order_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_p2p_escrow_order(p_asset_key text, p_side text, p_price numeric, p_quantity numeric, p_request_key uuid, p_client_order_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_p2p_escrow_order(p_asset_key text, p_side text, p_price numeric, p_quantity numeric, p_request_key uuid, p_client_order_id text) TO authenticated;
GRANT ALL ON FUNCTION public.reserve_p2p_escrow_order(p_asset_key text, p_side text, p_price numeric, p_quantity numeric, p_request_key uuid, p_client_order_id text) TO service_role;


--
-- Name: FUNCTION reserve_vault_jc_purchase(jc_amount numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_vault_jc_purchase(jc_amount numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_vault_jc_purchase(jc_amount numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.reserve_vault_jc_purchase(jc_amount numeric, request_key text) TO service_role;


--
-- Name: TABLE agency_applications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.agency_applications TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.agency_applications TO authenticated;
GRANT ALL ON TABLE public.agency_applications TO service_role;


--
-- Name: FUNCTION review_agency_application(application_id uuid, decision text, reject_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.review_agency_application(application_id uuid, decision text, reject_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.review_agency_application(application_id uuid, decision text, reject_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.review_agency_application(application_id uuid, decision text, reject_reason text) TO service_role;


--
-- Name: FUNCTION rwmt_town_open_house(p_house integer, p_answer bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rwmt_town_open_house(p_house integer, p_answer bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rwmt_town_open_house(p_house integer, p_answer bigint) TO anon;
GRANT ALL ON FUNCTION public.rwmt_town_open_house(p_house integer, p_answer bigint) TO authenticated;
GRANT ALL ON FUNCTION public.rwmt_town_open_house(p_house integer, p_answer bigint) TO service_role;


--
-- Name: FUNCTION sandbox_deposit(target_user_id uuid, deposit_amount numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sandbox_deposit(target_user_id uuid, deposit_amount numeric, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sandbox_deposit(target_user_id uuid, deposit_amount numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.sandbox_deposit(target_user_id uuid, deposit_amount numeric, request_key text) TO service_role;


--
-- Name: FUNCTION service_set_active_safe(p_address text, p_admin_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.service_set_active_safe(p_address text, p_admin_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.service_set_active_safe(p_address text, p_admin_id uuid) TO service_role;


--
-- Name: FUNCTION service_set_p2p_fees(p_fee_bps integer, p_listing_fee numeric, p_admin_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.service_set_p2p_fees(p_fee_bps integer, p_listing_fee numeric, p_admin_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.service_set_p2p_fees(p_fee_bps integer, p_listing_fee numeric, p_admin_id uuid) TO service_role;


--
-- Name: FUNCTION set_own_promo_code(new_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_own_promo_code(new_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_own_promo_code(new_code text) TO authenticated;
GRANT ALL ON FUNCTION public.set_own_promo_code(new_code text) TO service_role;


--
-- Name: FUNCTION set_user_preferences_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_user_preferences_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_user_preferences_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_user_preferences_updated_at() TO service_role;


--
-- Name: FUNCTION submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_agency_application(p_role text, p_name text, p_contact text, p_region text, p_reason text, p_master_code text) TO service_role;


--
-- Name: FUNCTION sync_auth_user_profile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sync_auth_user_profile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_auth_user_profile() TO service_role;


--
-- Name: FUNCTION touch_last_login(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_last_login() FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_last_login() TO authenticated;
GRANT ALL ON FUNCTION public.touch_last_login() TO service_role;


--
-- Name: FUNCTION touch_telegram_notification_preferences_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_telegram_notification_preferences_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_telegram_notification_preferences_updated_at() TO service_role;


--
-- Name: FUNCTION vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.vault_buy_jc_onchain(jc_amount numeric, tx_hash text, request_key text) TO service_role;


--
-- Name: FUNCTION vault_exchange_jc(direction text, jc_amount numeric, request_key text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vault_exchange_jc(direction text, jc_amount numeric, request_key text) TO anon;
GRANT ALL ON FUNCTION public.vault_exchange_jc(direction text, jc_amount numeric, request_key text) TO authenticated;
GRANT ALL ON FUNCTION public.vault_exchange_jc(direction text, jc_amount numeric, request_key text) TO service_role;


--
-- Name: TABLE admin_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.admin_audit_logs TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.admin_audit_logs TO authenticated;
GRANT ALL ON TABLE public.admin_audit_logs TO service_role;


--
-- Name: TABLE automation_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_state TO anon;
GRANT ALL ON TABLE public.automation_state TO authenticated;
GRANT ALL ON TABLE public.automation_state TO service_role;


--
-- Name: TABLE background_push_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.background_push_logs TO service_role;


--
-- Name: TABLE commission_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.commission_logs TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.commission_logs TO authenticated;
GRANT ALL ON TABLE public.commission_logs TO service_role;


--
-- Name: TABLE commission_processing_errors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_processing_errors TO service_role;
GRANT SELECT ON TABLE public.commission_processing_errors TO authenticated;


--
-- Name: TABLE commission_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_settings TO anon;
GRANT ALL ON TABLE public.commission_settings TO authenticated;
GRANT ALL ON TABLE public.commission_settings TO service_role;


--
-- Name: TABLE commission_user_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.commission_user_overrides TO service_role;


--
-- Name: TABLE holdings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.holdings TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.holdings TO authenticated;
GRANT ALL ON TABLE public.holdings TO service_role;


--
-- Name: TABLE jc_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.jc_ledger TO anon;
GRANT ALL ON TABLE public.jc_ledger TO authenticated;
GRANT ALL ON TABLE public.jc_ledger TO service_role;


--
-- Name: TABLE market_price_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.market_price_snapshots TO service_role;


--
-- Name: TABLE onchain_settlements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.onchain_settlements TO anon;
GRANT ALL ON TABLE public.onchain_settlements TO authenticated;
GRANT ALL ON TABLE public.onchain_settlements TO service_role;


--
-- Name: TABLE p2p_escrow_cutover_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.p2p_escrow_cutover_audit TO service_role;


--
-- Name: TABLE p2p_escrow_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.p2p_escrow_events TO service_role;


--
-- Name: TABLE p2p_escrow_fills; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.p2p_escrow_fills TO service_role;


--
-- Name: TABLE p2p_escrow_order_reservations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.p2p_escrow_order_reservations TO service_role;
GRANT SELECT ON TABLE public.p2p_escrow_order_reservations TO authenticated;


--
-- Name: TABLE p2p_orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.p2p_orders TO service_role;


--
-- Name: TABLE platform_fee_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_fee_ledger TO service_role;


--
-- Name: TABLE push_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;


--
-- Name: TABLE redemption_orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.redemption_orders TO anon;
GRANT ALL ON TABLE public.redemption_orders TO authenticated;
GRANT ALL ON TABLE public.redemption_orders TO service_role;


--
-- Name: TABLE referral_binding_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.referral_binding_logs TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.referral_binding_logs TO authenticated;
GRANT ALL ON TABLE public.referral_binding_logs TO service_role;


--
-- Name: TABLE rwa_placement_escrows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rwa_placement_escrows TO anon;
GRANT ALL ON TABLE public.rwa_placement_escrows TO authenticated;
GRANT ALL ON TABLE public.rwa_placement_escrows TO service_role;


--
-- Name: TABLE rwmt_town_opens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rwmt_town_opens TO service_role;


--
-- Name: SEQUENCE rwmt_town_opens_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.rwmt_town_opens_id_seq TO anon;
GRANT ALL ON SEQUENCE public.rwmt_town_opens_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.rwmt_town_opens_id_seq TO service_role;


--
-- Name: TABLE rwmt_town_rounds; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rwmt_town_rounds TO service_role;


--
-- Name: SEQUENCE rwmt_town_rounds_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.rwmt_town_rounds_id_seq TO anon;
GRANT ALL ON SEQUENCE public.rwmt_town_rounds_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.rwmt_town_rounds_id_seq TO service_role;


--
-- Name: TABLE safe_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.safe_proposals TO service_role;


--
-- Name: TABLE settlement_reservations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.settlement_reservations TO service_role;
GRANT SELECT ON TABLE public.settlement_reservations TO authenticated;


--
-- Name: TABLE system_monitor_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_monitor_events TO service_role;


--
-- Name: TABLE system_monitor_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_monitor_state TO service_role;


--
-- Name: TABLE telegram_delivery_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.telegram_delivery_logs TO service_role;


--
-- Name: TABLE telegram_link_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.telegram_link_tokens TO service_role;


--
-- Name: TABLE telegram_notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.telegram_notification_preferences TO service_role;


--
-- Name: TABLE telegram_support_question_topics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.telegram_support_question_topics TO service_role;


--
-- Name: TABLE telegram_user_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.telegram_user_links TO service_role;


--
-- Name: TABLE user_announcement_reads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_announcement_reads TO anon;
GRANT ALL ON TABLE public.user_announcement_reads TO authenticated;
GRANT ALL ON TABLE public.user_announcement_reads TO service_role;


--
-- Name: TABLE user_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--
