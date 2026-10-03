CREATE OR REPLACE FUNCTION public.admin_set_jc_price(new_price numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
$function$;

DO $verify$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef('public.admin_set_jc_price(numeric)'::regprocedure)
    INTO function_definition;

  IF function_definition NOT LIKE '%where id = true%' THEN
    RAISE EXCEPTION 'admin_set_jc_price is missing the singleton-row WHERE clause';
  END IF;
END
$verify$;
