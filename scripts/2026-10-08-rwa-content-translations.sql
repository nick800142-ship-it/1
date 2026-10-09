create or replace function public.admin_update_placement_translations(
  p_id text,
  p_translations jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_email text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_id is null or trim(p_id) = '' or jsonb_typeof(p_translations) <> 'object' then
    raise exception 'invalid translation payload' using errcode = '22023';
  end if;

  update public.private_placements
  set translations = p_translations,
      updated_at = now()
  where id = p_id;

  if not found then
    raise exception 'placement not found' using errcode = 'P0002';
  end if;

  select email into admin_email
  from auth.users
  where id = auth.uid();

  insert into public.admin_audit_logs (
    admin_id,
    admin_email,
    action,
    target_type,
    target_id,
    details
  ) values (
    auth.uid(),
    admin_email,
    'translate',
    'private_placement',
    p_id,
    jsonb_build_object('languages', (select count(*) from jsonb_object_keys(p_translations)))
  );
end;
$$;

revoke all on function public.admin_update_placement_translations(text, jsonb) from public, anon;
grant execute on function public.admin_update_placement_translations(text, jsonb) to authenticated;
