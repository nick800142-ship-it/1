create table if not exists public.user_announcement_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  announcement_id uuid not null references public.platform_announcements(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, announcement_id)
);

alter table public.user_announcement_reads enable row level security;

drop policy if exists "users_read_own_announcement_reads" on public.user_announcement_reads;
create policy "users_read_own_announcement_reads"
  on public.user_announcement_reads for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "users_insert_own_announcement_reads" on public.user_announcement_reads;
create policy "users_insert_own_announcement_reads"
  on public.user_announcement_reads for insert to authenticated
  with check ((select auth.uid()) = user_id);

grant select, insert on public.user_announcement_reads to authenticated;
