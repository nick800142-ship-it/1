-- Fix announcement publishing so generated translations are persisted.
-- Applied to the live Supabase database on 2026-10-08.

create or replace function public.admin_publish_announcement(title_text text, content_text text, translations_json jsonb default '{}'::jsonb)
returns public.platform_announcements
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r public.platform_announcements;
  u_email text;
  clean_translations jsonb := case
    when jsonb_typeof(coalesce(translations_json, '{}'::jsonb)) = 'object'
      then coalesce(translations_json, '{}'::jsonb)
    else '{}'::jsonb
  end;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if trim(coalesce(title_text,''))='' or trim(coalesce(content_text,''))='' or char_length(title_text)>120 or char_length(content_text)>2000 or title_text like '%�%' or content_text like '%�%' then
    raise exception 'invalid announcement';
  end if;
  insert into public.platform_announcements(title, content, translations, created_by, is_active)
  values (trim(title_text), trim(content_text), clean_translations, auth.uid(), true)
  returning * into r;
  select email into u_email from public.profiles where id=auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, auth.jwt()->>'email',''), 'announcement.publish', 'announcement', r.id::text, jsonb_build_object('title', r.title));
  return r;
end
$function$;

-- Existing rows with missing translations should be repaired with the admin's
-- normal translation flow rather than silently falling back to Traditional Chinese.
-- The live Telegram announcement was repaired separately after this function fix.
-- Future repairs can call admin_publish_announcement or update translations through
-- the existing admin-only workflow.

revoke all on function public.admin_publish_announcement(text, text, jsonb) from public;
grant execute on function public.admin_publish_announcement(text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- Verification:
-- select id, translations->'ko'->>'title' from public.platform_announcements order by created_at desc limit 1;
-- Expected: a translated Korean title, not NULL.
