-- 完了日時（TTL）と試行日時（公平なローテーション）を分離する。
ALTER TABLE "nagi"."actors"
  ADD COLUMN IF NOT EXISTS "news_reasons_attempted_at" timestamptz;
