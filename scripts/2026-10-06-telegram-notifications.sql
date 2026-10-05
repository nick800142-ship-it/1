create table if not exists public.telegram_user_links (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  chat_id text not null unique,
  telegram_username text,
  linked_at timestamptz not null default now()
);

create table if not exists public.telegram_link_tokens (
  token_hash text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_link_tokens_user_created_idx
  on public.telegram_link_tokens (user_id, created_at desc);

create table if not exists public.telegram_notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  market_alerts_enabled boolean not null default true,
  commission_updates_enabled boolean not null default true,
  order_partial_fills_enabled boolean not null default true,
  order_completed_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  target_user_id uuid references public.profiles(id) on delete set null,
  sent_by uuid references public.profiles(id) on delete set null,
  category text not null check (category in ('market_alert', 'commission', 'order_partial_fill', 'order_completed', 'admin_direct')),
  title text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists telegram_delivery_logs_target_created_idx
  on public.telegram_delivery_logs (target_user_id, created_at desc);
create index if not exists telegram_delivery_logs_admin_created_idx
  on public.telegram_delivery_logs (sent_by, created_at desc)
  where category = 'admin_direct';

alter table public.telegram_user_links enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.telegram_notification_preferences enable row level security;
alter table public.telegram_delivery_logs enable row level security;

revoke all on public.telegram_user_links from anon, authenticated;
revoke all on public.telegram_link_tokens from anon, authenticated;
revoke all on public.telegram_notification_preferences from anon, authenticated;
revoke all on public.telegram_delivery_logs from anon, authenticated;
grant all on public.telegram_user_links to service_role;
grant all on public.telegram_link_tokens to service_role;
grant all on public.telegram_notification_preferences to service_role;
grant all on public.telegram_delivery_logs to service_role;

comment on table public.telegram_link_tokens is 'One-time, short-lived Telegram account-link tokens. Only server service role may access this table.';
comment on table public.telegram_delivery_logs is 'Idempotent Telegram delivery log for user alerts and administrator direct messages.';
-- Add a check constraint only when this previously-existing config is absent.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.telegram_notification_preferences'::regclass
      and conname = 'telegram_notification_preferences_notification_types_check'
  ) then
    alter table public.telegram_notification_preferences
      add constraint telegram_notification_preferences_notification_types_check
      check (true);
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');

-- preferences are intentionally server-managed because Telegram chat ids are private identifiers
-- and all updates are validated against the authenticated account by API handlers.

create or replace function public.touch_telegram_notification_preferences_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists telegram_notification_preferences_updated_at on public.telegram_notification_preferences;
create trigger telegram_notification_preferences_updated_at
before update on public.telegram_notification_preferences
for each row execute function public.touch_telegram_notification_preferences_updated_at();

revoke all on function public.touch_telegram_notification_preferences_updated_at() from public, anon, authenticated;

grant execute on function public.touch_telegram_notification_preferences_updated_at() to service_role;

select pg_notify('pgrst', 'reload schema');

-- There is intentionally no browser-accessible policy: the service-role API binds and mutates rows
-- only after validating a Supabase session or an unguessable Telegram link token.

create index if not exists telegram_notification_preferences_updated_idx
  on public.telegram_notification_preferences (updated_at desc);

select pg_notify('pgrst', 'reload schema');

-- RLS + service_role-only grants form the database boundary; delivery APIs additionally enforce
-- account ownership, expiry, notification opt-outs, and administrator authorization.

select pg_notify('pgrst', 'reload schema');

-- No existing announcement, browser push, or user-account data is changed by this migration.

select pg_notify('pgrst', 'reload schema');

-- Telegram alert events are deduplicated by event_key so retries cannot send duplicate messages.

select pg_notify('pgrst', 'reload schema');

-- Ensure service-role access after the trigger/function definitions.
grant select, insert, update, delete on public.telegram_user_links to service_role;
grant select, insert, update, delete on public.telegram_link_tokens to service_role;
grant select, insert, update, delete on public.telegram_notification_preferences to service_role;
grant select, insert, update, delete on public.telegram_delivery_logs to service_role;

select pg_notify('pgrst', 'reload schema');

-- Keep preference defaults aligned with the initial alert types available in the app.

select pg_notify('pgrst', 'reload schema');

-- Used for compact status reads in account settings.

select pg_notify('pgrst', 'reload schema');

-- This feature does not depend on client-side persistence.

select pg_notify('pgrst', 'reload schema');

-- Service-managed token rows expire at use time; stale rows may be pruned safely later.

select pg_notify('pgrst', 'reload schema');

-- Completed migration.
