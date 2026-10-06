create table if not exists public.telegram_support_question_topics (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in (
    '認購／購買流程',
    '二級市場／掛單成交',
    'AE／RWA 資產與標的',
    '錢包／JC／USDT',
    '登入／帳號／綁定',
    '代理／分潤／獎金',
    '費率／價格／手續費',
    '網站操作／錯誤',
    '其他'
  )),
  asked_at timestamptz not null default now()
);

create index if not exists telegram_support_question_topics_asked_at_idx
  on public.telegram_support_question_topics (asked_at);

alter table public.telegram_support_question_topics enable row level security;

revoke all on table public.telegram_support_question_topics from anon, authenticated;
grant all on table public.telegram_support_question_topics to service_role;

comment on table public.telegram_support_question_topics is
  'Anonymous Telegram support question topic counts; intentionally stores no message text, chat ID, or user ID.';
