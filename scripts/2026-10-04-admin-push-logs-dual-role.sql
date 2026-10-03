create or replace function public.admin_list_background_push_logs()
returns table (
  id uuid,
  title text,
  body text,
  sent_count integer,
  failed_count integer,
  removed_count integer,
  target_count integer,
  subscriber_count integer,
  created_at timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    logs.id,
    logs.title,
    logs.body,
    logs.sent_count,
    logs.failed_count,
    logs.removed_count,
    logs.target_count,
    logs.subscriber_count,
    logs.created_at
  from public.background_push_logs as logs
  order by logs.created_at desc;
end;
$function$;
