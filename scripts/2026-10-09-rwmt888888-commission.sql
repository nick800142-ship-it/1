create or replace function private.post_referral_commissions(buyer_id uuid, asset_key text, transaction_kind text, gross numeric, source_id uuid, request_key text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  buyer public.profiles; ref public.profiles; agent public.profiles; master public.profiles;
  master_is_direct boolean := false; special_master boolean := false;
  master_role_key text; agent_bonus_type text; master_bonus_type text;
  src_entry text; src_created timestamptz; month_start date;
  agent_base numeric := 0; agent_boost numeric := 0; agent_rate numeric := 0;
  master_base numeric := 0; master_boost numeric := 0; master_rate numeric := 0;
  amount_value numeric; ledger_id uuid; resolved_asset_mode text;
  has_downline_performance boolean := false;
begin
  select entry_type, created_at into src_entry, src_created from public.jc_ledger where id = source_id;
  if transaction_kind = 'private' then
    if src_entry is distinct from 'private_purchase' then return; end if;
  elsif transaction_kind = 'secondary' then
    if src_entry is null or src_entry not in ('secondary_sell','p2p_sell') then return; end if;
  else return;
  end if;
  month_start := date_trunc('month', coalesce(src_created, now()))::date;

  select case when is_ae_token then 'ae_coin' else 'rwa' end into resolved_asset_mode
    from public.private_placements where id = asset_key;
  resolved_asset_mode := coalesce(resolved_asset_mode, 'ae_coin');
  select * into buyer from public.profiles where id = buyer_id;
  if buyer.id is null then return; end if;

  if buyer.agency_role = '總代理' then
    master := buyer; master_is_direct := true;
  elsif buyer.agency_role = '代理' then
    agent := buyer;
    if buyer.master_agent_id is not null then
      select * into master from public.profiles where id = buyer.master_agent_id;
    end if;
  else
    if buyer.referrer_id is not null then select * into ref from public.profiles where id = buyer.referrer_id; end if;
    if ref.id is not null and upper(coalesce(ref.promo_code, '')) = 'RWMT88888' then
      master := ref; master_is_direct := true; special_master := true;
    elsif ref.id is not null and ref.agency_role = '代理' then
      agent := ref;
      if ref.master_agent_id is not null then select * into master from public.profiles where id = ref.master_agent_id;
      elsif buyer.master_agent_id is not null then select * into master from public.profiles where id = buyer.master_agent_id; end if;
    elsif ref.id is not null and ref.agency_role = '總代理' then
      master := ref; master_is_direct := true;
    elsif buyer.master_agent_id is not null then
      select * into master from public.profiles where id = buyer.master_agent_id; master_is_direct := true;
    end if;
  end if;

  if agent.id is not null then
    agent_bonus_type := case when agent.id = buyer_id then 'personal' else 'team' end;
    select case when transaction_kind = 'private' then coalesce(o.private_rate, s.private_rate) else coalesce(o.secondary_rate, s.secondary_rate) end
      into agent_base from public.commission_settings s
      left join public.commission_user_overrides o on o.user_id = agent.id and o.asset_mode = resolved_asset_mode
      where s.agency_role = '代理' and s.asset_mode = resolved_asset_mode;
    agent_base := coalesce(agent_base, case when transaction_kind = 'private' then .01 else .0007 end);
    agent_boost := private.agent_six_month_boost(agent.id, month_start); agent_rate := agent_base + agent_boost;
    amount_value := round(gross * agent_rate, 6);
    if amount_value > 0 then
      insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
      values(agent.id, 'commission_pending', amount_value, asset_key, request_key || '-personal', jsonb_build_object('bonus_type',agent_bonus_type,'rate',agent_rate,'source_ledger_id',source_id,'asset_mode',resolved_asset_mode)) returning id into ledger_id;
      insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency)
      values(agent.id,buyer_id,asset_key,transaction_kind,gross,agent_rate,amount_value,ledger_id,agent_bonus_type,agent.id,agent.id,buyer_id,source_id,agent_base,agent_boost,agent_rate,month_start,'jc');
    end if;
  end if;

  if master.id is not null then
    if special_master then
      select exists (
        select 1 from public.jc_ledger l
        join public.profiles child on child.id = l.user_id
        where child.referrer_id = master.id
          and l.entry_type in ('private_purchase','p2p_sell','secondary_sell')
          and l.amount < 0
      ) into has_downline_performance;
      if transaction_kind = 'secondary' and not has_downline_performance then return; end if;
    end if;
    master_bonus_type := case when master_is_direct then 'personal' else 'team' end;
    master_role_key := case when master_is_direct then '總代理直屬' else '總代理' end;
    select case when transaction_kind = 'private' then coalesce(o.private_rate, s.private_rate) else coalesce(o.secondary_rate, s.secondary_rate) end
      into master_base from public.commission_settings s
      left join public.commission_user_overrides o on o.user_id = master.id and o.asset_mode = resolved_asset_mode
      where s.agency_role = master_role_key and s.asset_mode = resolved_asset_mode;
    if special_master and transaction_kind = 'private' then master_base := .03;
    else master_base := coalesce(master_base, case when master_is_direct then case when transaction_kind = 'private' then .03 else .002 end else case when transaction_kind = 'private' then .02 else .0013 end); end if;
    master_boost := private.master_month_boost(master.id, month_start); master_rate := master_base + master_boost;
    amount_value := round(gross * master_rate, 6);
    if amount_value > 0 then
      insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata)
      values(master.id,'commission_pending',amount_value,asset_key,request_key || '-team',jsonb_build_object('bonus_type',master_bonus_type,'rate',master_rate,'direct',master_is_direct,'special_promo_code',case when special_master then 'RWMT88888' else null end,'source_ledger_id',source_id,'asset_mode',resolved_asset_mode)) returning id into ledger_id;
      insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency)
      values(master.id,buyer_id,asset_key,transaction_kind,gross,master_rate,amount_value,ledger_id,master_bonus_type,master.id,agent.id,buyer_id,source_id,master_base,master_boost,master_rate,month_start,'jc');
    end if;
  end if;
end $function$;

revoke all on function private.post_referral_commissions(uuid,text,text,numeric,uuid,text) from public;
grant execute on function private.post_referral_commissions(uuid,text,text,numeric,uuid,text) to authenticated;
