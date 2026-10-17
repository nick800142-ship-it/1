-- 2026-10-18: store the active Safe address in the database so changing Safe
-- needs no code change or redeploy. Only a confirmed on-chain migration
-- proposal (service role, via relayer) may switch it.

alter table public.platform_config
  add column if not exists active_safe_address text,
  add column if not exists active_safe_updated_at timestamptz;

update public.platform_config
set active_safe_address = coalesce(active_safe_address, '0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf')
where id = true;

alter table public.platform_config
  drop constraint if exists platform_config_active_safe_address_check;
alter table public.platform_config
  add constraint platform_config_active_safe_address_check
  check (active_safe_address is null or active_safe_address ~ '^0x[0-9a-fA-F]{40}$');

-- Vault purchase verification reads the Safe address from here, so it must
-- follow the active Safe instead of a constant.
create or replace function public.get_safe_vault_address()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select active_safe_address from public.platform_config where id = true),
    '0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf'
  )
$$;

create or replace function public.service_set_active_safe(p_address text, p_admin_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.service_set_active_safe(text, uuid) from public, anon, authenticated;
grant execute on function public.service_set_active_safe(text, uuid) to service_role;
