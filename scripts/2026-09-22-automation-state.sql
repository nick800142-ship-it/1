-- 供 relayer「機會式自動補發」使用的節流標記表。
-- Hobby 方案的 Vercel cron 最快只能每日一次，因此改為：每當有 relayer 請求
-- （認購 / 二級 / 掛單 / 金庫買幣 等）進來時，順手掃一小批卡單與待派發分潤，
-- 但用這張表把「全域掃描」節流到最多每 N 秒一次，避免每個請求都重複掃。
create table if not exists automation_state (
  key text primary key,
  last_run_at timestamptz not null default 'epoch'
);

-- 服務端（service_role）專用，前端不需要存取。
alter table automation_state enable row level security;

insert into automation_state (key, last_run_at)
values ('settle-sweep', 'epoch')
on conflict (key) do nothing;

-- 原子搶占節流窗：只有當距離上次執行超過 p_min_interval_seconds 時，才把
-- last_run_at 更新為現在並回傳 true（代表這個請求「搶到」這一輪掃描）。
-- 併發的其他請求會拿到 false，直接跳過，確保同一時間只有一個請求在掃。
create or replace function claim_sweep_slot(p_key text, p_min_interval_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into automation_state (key, last_run_at)
  values (p_key, now())
  on conflict (key) do update
    set last_run_at = now()
    where automation_state.last_run_at < now() - make_interval(secs => p_min_interval_seconds)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;
