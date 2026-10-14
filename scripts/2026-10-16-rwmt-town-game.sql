-- RWMT Town: rounds, shared AE draw, per-house three-digit double-operation challenges.
-- Everything (answer check, draw, AE stock, bomb JC deduction) runs server-side.

create table if not exists public.rwmt_town_rounds (
  id bigserial primary key,
  round_no int not null,
  theme text not null default 'modern' check (theme in ('modern','cyber','medieval','steam')),
  night boolean not null default false,
  house_count int not null check (house_count between 18 and 10000),
  ae_total int not null check (ae_total >= 1),
  ae_remaining int not null check (ae_remaining >= 0),
  bomb_total int not null check (bomb_total >= 0),
  bomb_remaining int not null check (bomb_remaining >= 0),
  bomb_jc numeric not null default 0.1 check (bomb_jc >= 0),
  seed bigint not null,
  status text not null default 'active' check (status in ('active','ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_by uuid
);
create unique index if not exists rwmt_town_rounds_one_active on public.rwmt_town_rounds ((status)) where status = 'active';

create table if not exists public.rwmt_town_opens (
  id bigserial primary key,
  round_id bigint not null references public.rwmt_town_rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  house_index int not null,
  result text not null check (result in ('ae','bomb','empty')),
  jc_penalty numeric not null default 0,
  penalty_status text not null default 'none' check (penalty_status in ('none','charged','cooldown')),
  prize_status text not null default 'none' check (prize_status in ('none','pending','paid')),
  created_at timestamptz not null default now(),
  unique (round_id, user_id, house_index)
);
create index if not exists rwmt_town_opens_round_house on public.rwmt_town_opens (round_id, house_index);

alter table public.rwmt_town_rounds enable row level security;
alter table public.rwmt_town_opens enable row level security;
revoke all on public.rwmt_town_rounds from anon, authenticated;
revoke all on public.rwmt_town_opens from anon, authenticated;

create or replace function private.rwmt_rand(p_seed bigint, p_house int, p_k int)
returns bigint language sql immutable set search_path to '' as $$
  select abs(hashtextextended(p_seed::text || ':' || p_house::text || ':' || p_k::text, 0));
$$;

create or replace function private.rwmt_challenge(p_seed bigint, p_house int)
returns table(question text, answer bigint) language plpgsql immutable set search_path to '' as $$
declare
  t int := (private.rwmt_rand(p_seed, p_house, 0) % 6)::int;
  a bigint := 100 + private.rwmt_rand(p_seed, p_house, 1) % 900;
  b bigint := 100 + private.rwmt_rand(p_seed, p_house, 2) % 900;
  c bigint := 100 + private.rwmt_rand(p_seed, p_house, 3) % 900;
  tmp bigint; k bigint; s bigint; lo bigint; hi bigint;
begin
  if t = 0 then
    question := format('(%s + %s) × %s', a, b, c); answer := (a + b) * c;
  elsif t = 1 then
    if a < b then tmp := a; a := b; b := tmp; end if;
    if a = b then b := case when b > 100 then b - 1 else b end; a := case when a = b then a + 1 else a end; end if;
    question := format('(%s − %s) × %s', a, b, c); answer := (a - b) * c;
  elsif t = 2 then
    question := format('%s × %s − %s', a, b, c); answer := a * b - c;
  elsif t = 3 then
    question := format('%s × %s + %s', a, b, c); answer := a * b + c;
  elsif t = 4 then
    c := 100 + private.rwmt_rand(p_seed, p_house, 4) % 400;
    k := 2 + private.rwmt_rand(p_seed, p_house, 5) % 2;
    s := c * k;
    lo := greatest(100, s - 999); hi := least(999, s - 100);
    a := lo + private.rwmt_rand(p_seed, p_house, 6) % (hi - lo + 1);
    b := s - a;
    question := format('(%s + %s) ÷ %s', a, b, c); answer := k;
  else
    if b < c then tmp := b; b := c; c := tmp; end if;
    if b = c then c := case when c > 100 then c - 1 else c end; b := case when b = c then b + 1 else b end; end if;
    question := format('%s × (%s − %s)', a, b, c); answer := a * (b - c);
  end if;
  return next;
end
$$;

create or replace function public.get_rwmt_town_state()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r public.rwmt_town_rounds; cfg jsonb; opened jsonb := '[]'::jsonb;
begin
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1;
  if not found then
    select * into r from public.rwmt_town_rounds order by id desc limit 1;
  end if;
  select rwmt_town_config into cfg from public.platform_config where id = true;
  if r.id is not null and auth.uid() is not null then
    select coalesce(jsonb_agg(jsonb_build_object('house', o.house_index, 'result', o.result)), '[]'::jsonb)
      into opened from public.rwmt_town_opens o where o.round_id = r.id and o.user_id = auth.uid();
  end if;
  return jsonb_build_object(
    'config', coalesce(cfg, '{}'::jsonb),
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'round_no', r.round_no, 'theme', r.theme, 'night', r.night,
      'house_count', r.house_count, 'ae_total', r.ae_total, 'ae_remaining', r.ae_remaining,
      'bomb_jc', r.bomb_jc, 'status', r.status, 'started_at', r.started_at, 'ended_at', r.ended_at) end,
    'opened', opened);
end
$$;

create or replace function public.get_rwmt_town_challenge(p_house int)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r public.rwmt_town_rounds; q text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1;
  if not found then raise exception 'no active round'; end if;
  if p_house < 0 or p_house >= r.house_count then raise exception 'invalid house'; end if;
  select c.question into q from private.rwmt_challenge(r.seed, p_house) c;
  return jsonb_build_object('house', p_house, 'question', q);
end
$$;

create or replace function public.rwmt_town_open_house(p_house int, p_answer bigint)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := auth.uid(); r public.rwmt_town_rounds; expected bigint; existing text;
  opened_houses int; remaining int; x double precision; res text := 'empty';
  penalty numeric := 0; p_status text := 'none'; prize text := 'none'; bal numeric;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.is_account_active(uid) then raise exception 'account frozen' using errcode = '42501'; end if;
  select * into r from public.rwmt_town_rounds where status = 'active' limit 1 for update;
  if not found then raise exception 'no active round'; end if;
  if p_house < 0 or p_house >= r.house_count then raise exception 'invalid house'; end if;

  select o.result into existing from public.rwmt_town_opens o
    where o.round_id = r.id and o.user_id = uid and o.house_index = p_house;
  if existing is not null then
    return jsonb_build_object('correct', true, 'already', true, 'result', existing,
      'ae_remaining', r.ae_remaining, 'ae_total', r.ae_total, 'status', r.status);
  end if;

  if exists (select 1 from public.rwmt_town_opens o where o.user_id = uid and o.penalty_status = 'cooldown'
             and o.created_at > now() - interval '10 minutes') then
    raise exception 'cooldown';
  end if;

  select c.answer into expected from private.rwmt_challenge(r.seed, p_house) c;
  if p_answer is distinct from expected then
    return jsonb_build_object('correct', false);
  end if;

  select count(distinct o.house_index) into opened_houses from public.rwmt_town_opens o where o.round_id = r.id;
  remaining := greatest(r.house_count - opened_houses, r.ae_remaining + r.bomb_remaining, 1);
  x := random();

  if r.ae_remaining > 0 and x < r.ae_remaining::double precision / remaining then
    res := 'ae'; prize := 'pending';
    update public.rwmt_town_rounds set ae_remaining = ae_remaining - 1,
      status = case when ae_remaining - 1 = 0 then 'ended' else status end,
      ended_at = case when ae_remaining - 1 = 0 then now() else ended_at end
      where id = r.id returning * into r;
  elsif r.bomb_remaining > 0 and x < (r.ae_remaining + r.bomb_remaining)::double precision / remaining then
    res := 'bomb';
    update public.rwmt_town_rounds set bomb_remaining = bomb_remaining - 1 where id = r.id returning * into r;
    bal := public.get_my_jc_balance();
    if r.bomb_jc > 0 and bal >= r.bomb_jc then
      insert into public.jc_ledger (user_id, entry_type, amount, idempotency_key, metadata)
      values (uid, 'town_bomb', -r.bomb_jc, 'town-bomb:' || r.id || ':' || uid || ':' || p_house,
              jsonb_build_object('round_id', r.id, 'house', p_house));
      penalty := r.bomb_jc; p_status := 'charged';
    elsif r.bomb_jc > 0 then
      p_status := 'cooldown';
    end if;
  end if;

  insert into public.rwmt_town_opens (round_id, user_id, house_index, result, jc_penalty, penalty_status, prize_status)
  values (r.id, uid, p_house, res, penalty, p_status, prize);

  return jsonb_build_object('correct', true, 'result', res, 'jc_penalty', penalty, 'penalty_status', p_status,
    'ae_remaining', r.ae_remaining, 'ae_total', r.ae_total, 'status', r.status);
end
$$;

create or replace function public.admin_start_rwmt_town_round(
  p_theme text, p_night boolean, p_house_count int, p_ae_total int, p_bomb_total int, p_bomb_jc numeric, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare active_id bigint; next_no int; new_round public.rwmt_town_rounds; u_email text;
begin
  if not private.is_admin() then raise exception 'not authorized'; end if;
  if p_theme not in ('modern','cyber','medieval','steam') then raise exception 'invalid theme'; end if;
  if p_house_count < 18 or p_house_count > 10000 then raise exception 'house count must be 18-10000'; end if;
  if p_ae_total < 1 or p_ae_total > p_house_count then raise exception 'invalid ae total'; end if;
  if p_bomb_total < 0 or p_bomb_total + p_ae_total > p_house_count then raise exception 'invalid bomb total'; end if;
  if p_bomb_jc < 0 then raise exception 'invalid bomb jc'; end if;

  select id into active_id from public.rwmt_town_rounds where status = 'active' limit 1 for update;
  if active_id is not null then
    if not p_force then raise exception 'previous round still active'; end if;
    update public.rwmt_town_rounds set status = 'ended', ended_at = now() where id = active_id;
  end if;

  select coalesce(max(round_no), 0) + 1 into next_no from public.rwmt_town_rounds;
  insert into public.rwmt_town_rounds (round_no, theme, night, house_count, ae_total, ae_remaining, bomb_total, bomb_remaining, bomb_jc, seed, created_by)
  values (next_no, p_theme, p_night, p_house_count, p_ae_total, p_ae_total, p_bomb_total, p_bomb_total, p_bomb_jc,
          (random() * 9e15)::bigint, auth.uid())
  returning * into new_round;

  update public.platform_config set rwmt_town_config = coalesce(rwmt_town_config, '{}'::jsonb)
    || jsonb_build_object('theme', p_theme, 'night', p_night, 'house_count', p_house_count), updated_at = now(), updated_by = auth.uid()
    where id = true;

  select email into u_email from public.profiles where id = auth.uid();
  insert into public.admin_audit_logs (admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), coalesce(u_email, ''), 'rwmt.town.round.start', 'rwmt_town_round', new_round.id::text,
          jsonb_build_object('round_no', next_no, 'theme', p_theme, 'house_count', p_house_count, 'ae_total', p_ae_total,
                             'bomb_total', p_bomb_total, 'bomb_jc', p_bomb_jc, 'forced', active_id is not null));
  return jsonb_build_object('id', new_round.id, 'round_no', next_no);
end
$$;

revoke all on function public.get_rwmt_town_state() from public;
revoke all on function public.get_rwmt_town_challenge(int) from public;
revoke all on function public.rwmt_town_open_house(int, bigint) from public;
revoke all on function public.admin_start_rwmt_town_round(text, boolean, int, int, int, numeric, boolean) from public;
grant execute on function public.get_rwmt_town_state() to authenticated;
grant execute on function public.get_rwmt_town_challenge(int) to authenticated;
grant execute on function public.rwmt_town_open_house(int, bigint) to authenticated;
grant execute on function public.admin_start_rwmt_town_round(text, boolean, int, int, int, numeric, boolean) to authenticated;

-- First round so the town shows real AE stock immediately.
insert into public.rwmt_town_rounds (round_no, theme, night, house_count, ae_total, ae_remaining, bomb_total, bomb_remaining, bomb_jc, seed)
select 1, 'modern', false, 10000, 5, 5, 300, 300, 0.1, (random() * 9e15)::bigint
where not exists (select 1 from public.rwmt_town_rounds);
