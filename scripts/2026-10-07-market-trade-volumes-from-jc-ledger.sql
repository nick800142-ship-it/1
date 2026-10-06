create or replace function public.get_market_trade_volumes(asset_key text)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select case when auth.uid() is null then '[]'::jsonb else coalesce(jsonb_agg(jsonb_build_object(
    'quantity', abs(l.quantity),
    'recorded_at', l.created_at
  ) order by l.created_at asc), '[]'::jsonb) end
  from public.jc_ledger l
  where l.asset_id = asset_key and l.entry_type = 'p2p_buy';
$function$;

comment on function public.get_market_trade_volumes(text) is
  'Returns one volume row per secondary-market fill from the buyer-side JC ledger entry, avoiding mirrored seller-side double counts.';

-- Verify the RPC reads the current secondary-market ledger source.
select position('public.jc_ledger' in pg_get_functiondef('public.get_market_trade_volumes(text)'::regprocedure)) > 0
  as reads_jc_ledger;
select asset_id, count(*) as fills, sum(abs(quantity)) as total_volume
from public.jc_ledger
where entry_type = 'p2p_buy'
group by asset_id
order by asset_id;
