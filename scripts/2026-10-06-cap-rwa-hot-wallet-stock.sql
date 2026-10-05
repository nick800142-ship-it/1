create or replace function public.admin_cap_rwa_placement_available(
  p_placement_id text,
  p_chain_quantity numeric
)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $function$
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
$function$;

revoke all on function public.admin_cap_rwa_placement_available(text, numeric) from public, anon, authenticated;
grant execute on function public.admin_cap_rwa_placement_available(text, numeric) to service_role;
