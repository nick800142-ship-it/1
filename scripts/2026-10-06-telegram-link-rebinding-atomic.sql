create or replace function public.complete_telegram_account_link(
  p_token_hash text,
  p_chat_id text,
  p_telegram_username text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_previous_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Telegram link token';
  end if;
  if p_chat_id is null or p_chat_id !~ '^-?[0-9]{1,20}$' then
    raise exception 'Invalid Telegram chat id';
  end if;
  if p_telegram_username is not null and p_telegram_username !~ '^[A-Za-z0-9_]{5,32}$' then
    raise exception 'Invalid Telegram username';
  end if;

  select token.user_id
    into v_user_id
    from public.telegram_link_tokens as token
   where token.token_hash = p_token_hash
     and token.used_at is null
     and token.expires_at > v_now
   for update;

  if v_user_id is null then
    return null;
  end if;

  update public.telegram_link_tokens
     set used_at = v_now
   where token_hash = p_token_hash;

  select link.user_id
    into v_previous_user_id
    from public.telegram_user_links as link
   where link.chat_id = p_chat_id
   for update;

  delete from public.telegram_user_links
   where chat_id = p_chat_id
     and user_id <> v_user_id;

  insert into public.telegram_user_links (user_id, chat_id, telegram_username, linked_at)
  values (v_user_id, p_chat_id, p_telegram_username, v_now)
  on conflict (user_id) do update
    set chat_id = excluded.chat_id,
        telegram_username = excluded.telegram_username,
        linked_at = excluded.linked_at;

  return jsonb_build_object(
    'user_id', v_user_id,
    'replaced_existing', v_previous_user_id is not null and v_previous_user_id <> v_user_id
  );
end;
$$;

revoke all on function public.complete_telegram_account_link(text, text, text) from public, anon, authenticated;
grant execute on function public.complete_telegram_account_link(text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
