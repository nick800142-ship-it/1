create or replace function public.admin_secondary_fee_attribution_rows()
returns table(
  id uuid,
  amount numeric,
  source_type text,
  created_at timestamptz,
  payer_id uuid,
  asset_id text
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
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
$function$;

revoke all on function public.admin_secondary_fee_attribution_rows() from public;
grant execute on function public.admin_secondary_fee_attribution_rows() to authenticated;

comment on function public.admin_secondary_fee_attribution_rows() is
  'Admin-only read of secondary revenue fees with payer and asset attribution for team revenue reporting.';

notify pgrst, 'reload schema';
