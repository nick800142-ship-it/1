-- Safe 多簽簽核佇列：高風險鏈上動作（鑄造／銷毀／RWA 建立與收回／二級費率）
-- 由後台建立提案 → Ledger 簽署 → 熱錢包代送 execTransaction（只付 Gas，無權限）。
create table if not exists public.safe_proposals (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  summary text not null,
  safe_address text not null,
  chain_id integer not null,
  to_address text not null,
  value text not null default '0',
  data text not null,
  operation smallint not null check (operation in (0, 1)),
  safe_nonce bigint not null,
  safe_tx_hash text not null,
  signatures jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'executing', 'executed', 'failed', 'stale', 'cancelled')),
  exec_tx_hash text,
  result jsonb,
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz
);
create index if not exists safe_proposals_status_idx on public.safe_proposals (status, created_at desc);
alter table public.safe_proposals enable row level security;
revoke all on public.safe_proposals from anon, authenticated;
