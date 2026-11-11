-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 通知設定（種別ごとの list / push）。行が無い人はすべて既定（両方 true）。
CREATE TABLE IF NOT EXISTS "nagi"."notification_preferences" (
  "did" text PRIMARY KEY NOT NULL,
  "preferences" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
