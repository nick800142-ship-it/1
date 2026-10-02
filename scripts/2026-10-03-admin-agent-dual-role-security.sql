create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.agency_role in ('admin', '管理員')
        or p.role in ('admin', 'super_admin')
      )
  );
$function$;

create or replace function private.guard_profile_privilege_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() = old.id
     and not private.is_admin()
     and (
       new.agency_role is distinct from old.agency_role
       or new.role is distinct from old.role
       or new.referrer_id is distinct from old.referrer_id
       or new.parent_id is distinct from old.parent_id
       or new.master_agent_id is distinct from old.master_agent_id
     ) then
    raise exception 'profile role and hierarchy fields can only be changed by an administrator'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists guard_profile_privilege_changes on public.profiles;
create trigger guard_profile_privilege_changes
before update of agency_role, role, referrer_id, parent_id, master_agent_id
on public.profiles
for each row
execute function private.guard_profile_privilege_changes();

revoke all on function private.guard_profile_privilege_changes() from public, anon, authenticated;
revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated, service_role;
