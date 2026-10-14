ALTER TABLE public.platform_config ADD COLUMN IF NOT EXISTS rwmt_town_config jsonb NOT NULL DEFAULT '{"theme":"modern","night":true,"house_count":48,"house_gap":3.2}'::jsonb;

UPDATE public.platform_config SET rwmt_town_config = COALESCE(rwmt_town_config, '{"theme":"modern","night":true,"house_count":48,"house_gap":3.2}'::jsonb) WHERE id = true;

CREATE OR REPLACE FUNCTION public.admin_set_rwmt_town_config(p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare
  clean jsonb;
  u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if jsonb_typeof(p_config) <> 'object' then raise exception 'invalid config'; end if;
  clean := jsonb_build_object(
    'theme', case when p_config->>'theme' in ('modern','cyber','medieval','steam') then p_config->>'theme' else 'modern' end,
    'night', coalesce((p_config->>'night')::boolean, true),
    'house_count', least(200, greatest(18, coalesce((p_config->>'house_count')::int, 48))),
    'house_gap', least(6, greatest(2.2, coalesce((p_config->>'house_gap')::numeric, 3.2)))
  );
  update public.platform_config set rwmt_town_config=clean, updated_at=now(), updated_by=auth.uid() where id=true;
  if not found then raise exception 'platform config row is missing'; end if;
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),coalesce(u_email,''),'rwmt.town.config.update','platform_config','rwmt_town',clean);
  return clean;
end
$function$;
REVOKE ALL ON FUNCTION public.admin_set_rwmt_town_config(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_rwmt_town_config(jsonb) TO authenticated;
