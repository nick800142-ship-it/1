create or replace function public.submit_agency_application(
  p_role text,
  p_name text,
  p_contact text,
  p_region text,
  p_reason text,
  p_master_code text default null
)
returns public.agency_applications
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result public.agency_applications;
  master public.profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_role not in ('代理', '總代理') then
    raise exception 'invalid role';
  end if;
  if length(trim(p_name)) < 2
    or length(trim(p_contact)) < 3
    or length(trim(p_region)) < 2
    or length(trim(p_reason)) < 5 then
    raise exception 'incomplete application';
  end if;
  if exists (
    select 1 from public.agency_applications
    where user_id = auth.uid() and status = 'pending'
  ) then
    raise exception 'application pending';
  end if;
  if p_role = '代理' and nullif(trim(p_master_code), '') is not null then
    select * into master
    from public.profiles
    where upper(promo_code) = upper(trim(p_master_code))
      and agency_role = '總代理';
    if not found then
      raise exception 'invalid master promo code';
    end if;
  end if;
  insert into public.agency_applications (
    user_id, requested_role, contact_name, contact_method, region, reason, master_promo_code
  )
  values (
    auth.uid(), p_role, trim(p_name), trim(p_contact), trim(p_region), trim(p_reason),
    case when p_role = '代理' then nullif(upper(trim(p_master_code)), '') else null end
  )
  returning * into result;
  return result;
end
$function$;

create or replace function public.review_agency_application(
  application_id uuid,
  decision text,
  reject_reason text default null
)
returns public.agency_applications
language plpgsql
security definer
set search_path = ''
as $function$
declare
  app public.agency_applications;
  master public.profiles;
  admin_email text;
  generated text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'invalid decision';
  end if;
  select * into app
  from public.agency_applications
  where id = application_id and status = 'pending'
  for update;
  if not found then
    raise exception 'application unavailable';
  end if;
  if decision = 'approved' then
    generated := private.generate_promo_code();
    if app.requested_role = '代理' then
      if nullif(trim(app.master_promo_code), '') is not null then
        select * into master
        from public.profiles
        where upper(promo_code) = upper(trim(app.master_promo_code))
          and agency_role = '總代理';
        if not found then
          raise exception 'master agent unavailable';
        end if;
      else
        select * into master
        from public.profiles
        where id = (
          select current_profile.master_agent_id
          from public.profiles current_profile
          where current_profile.id = app.user_id
        )
          and agency_role = '總代理';
      end if;
    end if;
    update public.profiles
    set agency_role = app.requested_role,
        promo_code = coalesce(promo_code, generated),
        master_agent_id = case when app.requested_role = '代理' then master.id else null end,
        role_approved_at = now()
    where id = app.user_id;
    insert into public.referral_binding_logs (
      user_id, new_master_agent_id, action, reason, actor_id
    )
    values (
      app.user_id,
      case when app.requested_role = '代理' then master.id else null end,
      'agency_approval',
      'Admin 核准代理申請',
      auth.uid()
    );
  end if;
  update public.agency_applications
  set status = decision,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      rejection_reason = case when decision = 'rejected' then nullif(trim(reject_reason), '') else null end,
      updated_at = now()
  where id = application_id
  returning * into app;
  select email into admin_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs (
    admin_id, admin_email, action, target_type, target_id, details
  )
  values (
    auth.uid(), admin_email, 'review_agency_application', 'agency_application', application_id::text,
    jsonb_build_object('decision', decision, 'user_id', app.user_id, 'requested_role', app.requested_role)
  );
  return app;
end
$function$;

comment on function public.submit_agency_application(text, text, text, text, text, text)
is 'Applies for an agency role; master promo code is optional so applicants can submit by role only.';

comment on function public.review_agency_application(uuid, text, text)
is 'Reviews agency applications; agent applications without a selected master remain unassigned until an admin binds them.';
