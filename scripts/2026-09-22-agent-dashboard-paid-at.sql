-- 讓代理中心的分潤明細能顯示「已發放 / 待發放」狀態。
-- get_agent_dashboard 的 commissions JSON 原本沒有回傳 paid_at；這裡在每筆分潤加上
-- paid_at，讓前端可以逐筆標示派發狀態（paid_at 不為 null = 已上鏈發放）。
-- 只改動 commissions 這段的 jsonb_build_object，其餘邏輯完全不變。
create or replace function public.get_agent_dashboard()
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  me public.profiles; start_month date := date_trunc('month', now())::date;
  members jsonb; logs jsonb; trades jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.agency_role not in ('代理','一代代理','二代代理','總代理') then raise exception 'not an approved agent'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'email',p.email,'display_name',p.display_name,'nickname',p.nickname,
    'agency_role',p.agency_role,'promo_code',p.promo_code,'referrer_id',p.referrer_id,
    'master_agent_id',p.master_agent_id,'last_login_at',p.last_login_at,'created_at',p.created_at,
    'monthly_investment',private.month_investment(p.id,start_month),
    'effective',private.is_effective_member(p.id,start_month),
    'balance',(select coalesce(sum(l.amount),0) from public.jc_ledger l where l.user_id=p.id and l.entry_type <> 'commission_pending'),
    'fees',(select coalesce(sum((l.metadata->>'fee')::numeric),0) from public.jc_ledger l where l.user_id=p.id and l.created_at>=start_month::timestamptz)
  ) order by p.created_at desc), '[]'::jsonb)
  into members from public.profiles p
  where case when me.agency_role='總代理' then p.referrer_id=me.id or p.master_agent_id=me.id else p.referrer_id=me.id end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'buyer_id',c.buyer_id,'asset_id',c.asset_id,'transaction_type',c.transaction_type,
    'transaction_amount',c.transaction_amount,'bonus_type',c.bonus_type,'base_rate',c.base_rate,
    'boost_rate',c.boost_rate,'effective_rate',c.effective_rate,'commission_amount',c.commission_amount,
    'commission_amount_ae',c.commission_amount_ae,'transaction_amount_ae',c.transaction_amount_ae,
    'display_currency',c.display_currency,'paid_at',c.paid_at,'created_at',c.created_at
  ) order by c.created_at desc), '[]'::jsonb)
  into logs from public.commission_logs c where c.beneficiary_id = me.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',l.id,'user_id',l.user_id,'entry_type',l.entry_type,'asset_id',l.asset_id,
    'is_ae_token',coalesce((select pp.is_ae_token from public.private_placements pp where pp.id = l.asset_id), false),
    'quantity',l.quantity,'amount',l.amount,
    'gross',coalesce((l.metadata->>'gross')::numeric,abs(l.amount)),
    'fee',coalesce((l.metadata->>'fee')::numeric,0),'created_at',l.created_at
  ) order by l.created_at desc), '[]'::jsonb)
  into trades from public.jc_ledger l
  where l.entry_type in ('private_purchase','p2p_buy','p2p_sell')
    and exists (select 1 from public.profiles p where p.id = l.user_id
      and case when me.agency_role='總代理' then p.referrer_id=me.id or p.master_agent_id=me.id else p.referrer_id=me.id end);

  return jsonb_build_object(
    'profile',jsonb_build_object('id',me.id,'email',me.email,'agency_role',me.agency_role,'promo_code',me.promo_code,'master_agent_id',me.master_agent_id),
    'members',members,'commissions',logs,'trades',trades,
    'new_effective_count',private.new_effective_count(me.id,start_month,me.agency_role='總代理'),
    'boost_rate',case when me.agency_role='總代理' then private.master_month_boost(me.id,start_month) else private.agent_six_month_boost(me.id,start_month) end
  );
end $function$;
