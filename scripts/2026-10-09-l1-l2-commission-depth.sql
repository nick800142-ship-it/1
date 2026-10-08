-- Future commission rule: beneficiary-relative referral depth.
-- Existing commission_logs remain unchanged for audit; only new rows use bonus_type l1/l2.
create or replace function private.post_referral_commissions(
  buyer_id uuid,
  asset_key text,
  transaction_kind text,
  gross numeric,
  source_id uuid,
  request_key text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  buyer public.profiles;
  beneficiary public.profiles;
  src_entry text;
  src_created timestamptz;
  month_start date;
  resolved_asset_mode text;
  depth integer;
  parent_id uuid;
  role_key text;
  base_rate numeric;
  boost_rate numeric;
  effective_rate numeric;
  amount_value numeric;
  ledger_id uuid;
  self_rate numeric := 0.03;
  self_eligible boolean := false;
  direct_child_id uuid;
begin
  select entry_type, created_at into src_entry, src_created
  from public.jc_ledger where id = source_id;

  if transaction_kind = 'private' and src_entry is distinct from 'private_purchase' then return; end if;
  if transaction_kind = 'secondary' and (src_entry is null or src_entry not in ('secondary_sell','p2p_sell')) then return; end if;
  if transaction_kind not in ('private', 'secondary') then return; end if;

  select * into buyer from public.profiles where id = buyer_id;
  if buyer.id is null then return; end if;

  select case when is_ae_token then 'ae_coin' else 'rwa' end into resolved_asset_mode
  from public.private_placements where id = asset_key;
  resolved_asset_mode := coalesce(resolved_asset_mode, 'ae_coin');
  month_start := date_trunc('month', coalesce(src_created, now()))::date;

  -- Private purchase self-rebate: an L0 becomes eligible after any L1/L2
  -- completes a first private purchase; RWMT88888 bypasses that requirement.
  if transaction_kind = 'private' then
    select exists (
      select 1
      from public.profiles child
      join public.jc_ledger first_purchase on first_purchase.user_id = child.id
      where (child.referrer_id = buyer.id or child.referrer_id in (
        select p1.id from public.profiles p1 where p1.referrer_id = buyer.id
      ))
        and first_purchase.entry_type = 'private_purchase'
        and first_purchase.amount < 0
    ) or upper(coalesce(buyer.promo_code, '')) = 'REMT88888'
    into self_eligible;

    if self_eligible then
      amount_value := round(gross * self_rate, 6);
      if amount_value > 0 then
        insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
        values (
          buyer.id, 'commission_pending', amount_value, asset_key,
          request_key || '-self',
          jsonb_build_object(
            'bonus_type', 'self_rebate',
            'commission_level', 'L0',
            'rate', self_rate,
            'source_ledger_id', source_id,
            'asset_mode', resolved_asset_mode,
            'eligibility', case when upper(coalesce(buyer.promo_code, '')) = 'REMT88888' then 'REMT88888' else 'l1_or_l2_first_investment' end
          )
        ) returning id into ledger_id;

        insert into public.commission_logs(
          agent_id, buyer_id, asset_id, transaction_type, transaction_amount,
          commission_rate, commission_amount, ledger_id, bonus_type,
          beneficiary_id, source_agent_id, source_user_id, source_ledger_id,
          base_rate, boost_rate, effective_rate, calculation_month, display_currency
        ) values (
          buyer.id, buyer.id, asset_key, transaction_kind, gross,
          self_rate, amount_value, ledger_id, 'self_rebate', buyer.id, buyer.id,
          buyer.id, source_id, self_rate, 0, self_rate, month_start, 'jc'
        );
      end if;
    end if;
  end if;

  parent_id := buyer.referrer_id;
  for depth in 1..2 loop
    exit when parent_id is null;
    select * into beneficiary from public.profiles where id = parent_id;
    exit when beneficiary.id is null;

    role_key := case when depth = 1 then '代理' else '總代理' end;
    if transaction_kind = 'secondary' then
      -- L1 seller: L0 receives 13/10000. L2 seller: L1 receives 13/10000 and L0 receives 7/10000.
      base_rate := case when depth = 1 then 0.0013 else 0.0007 end;
    else
      select coalesce(o.private_rate, s.private_rate) into base_rate
      from public.commission_settings s
      left join public.commission_user_overrides o
        on o.user_id = beneficiary.id and o.asset_mode = resolved_asset_mode
      where s.agency_role = role_key and s.asset_mode = resolved_asset_mode;
      base_rate := coalesce(base_rate,
        case when depth = 1 then .01 else .02 end);
    end if;
    boost_rate := coalesce(private.agent_six_month_boost(beneficiary.id, month_start), 0);
    effective_rate := base_rate + boost_rate;
    amount_value := round(gross * effective_rate, 6);

    if amount_value > 0 then
      insert into public.jc_ledger(user_id, entry_type, amount, asset_id, idempotency_key, metadata)
      values (
        beneficiary.id, 'commission_pending', amount_value, asset_key,
        request_key || '-l' || depth,
        jsonb_build_object(
          'bonus_type', case when depth = 1 then 'l1' else 'l2' end,
          'commission_level', case when depth = 1 then 'L1' else 'L2' end,
          'referral_depth', depth,
          'rate', effective_rate,
          'source_ledger_id', source_id,
          'asset_mode', resolved_asset_mode
        )
      ) returning id into ledger_id;

      insert into public.commission_logs(
        agent_id, buyer_id, asset_id, transaction_type, transaction_amount,
        commission_rate, commission_amount, ledger_id, bonus_type,
        beneficiary_id, source_agent_id, source_user_id, source_ledger_id,
        base_rate, boost_rate, effective_rate, calculation_month, display_currency
      ) values (
        beneficiary.id, buyer_id, asset_key, transaction_kind, gross,
        effective_rate, amount_value, ledger_id,
        case when depth = 1 then 'l1' else 'l2' end,
        beneficiary.id, beneficiary.id, buyer_id, source_id,
        base_rate, boost_rate, effective_rate, month_start, 'jc'
      );
    end if;

    parent_id := beneficiary.referrer_id;
  end loop;
end;
$function$;

revoke all on function private.post_referral_commissions(uuid,text,text,numeric,uuid,text) from public;
grant execute on function private.post_referral_commissions(uuid,text,text,numeric,uuid,text) to authenticated;

comment on function private.post_referral_commissions(uuid,text,text,numeric,uuid,text)
is 'Future commissions only: direct referral investment is L1, second-level referral investment is L2; deeper levels are excluded.';

-- Additive audit indexes for the new classification.
create index if not exists commission_logs_beneficiary_bonus_type_idx
  on public.commission_logs (beneficiary_id, bonus_type, created_at);
create index if not exists jc_ledger_commission_pending_bonus_type_idx
  on public.jc_ledger ((metadata->>'bonus_type'), user_id, created_at)
  where entry_type = 'commission_pending';
