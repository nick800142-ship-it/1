-- 客服統計僅保存 AI 判定的大方向與細項，不保存問題原文。
-- 舊紀錄沒有原文可供回溯，新增欄位預設為「未分類」。
ALTER TABLE public.telegram_support_question_topics
  ADD COLUMN IF NOT EXISTS subcategory text NOT NULL DEFAULT '未分類';

COMMENT ON COLUMN public.telegram_support_question_topics.subcategory IS
  'AI-generated support question subcategory label; legacy rows remain 未分類 because the question text is not stored.';
....................................................................................
