alter table public.telegram_support_question_topics drop constraint if exists telegram_support_question_topics_category_check;

alter table public.telegram_support_question_topics
  add constraint telegram_support_question_topics_category_check
  check (category in (
    '認購／購買流程',
    '二級市場／掛單成交',
    'AE／RWA 資產與標的',
    '錢包／JC／USDT',
    '登入／帳號／綁定',
    '設定／登入／帳號',
    '代理／分潤／獎金',
    '費率／價格／手續費',
    '網站操作／錯誤',
    '其他'
  ));

comment on constraint telegram_support_question_topics_category_check on public.telegram_support_question_topics is
  'Includes the legacy account category and the current settings/login/account category label.';
