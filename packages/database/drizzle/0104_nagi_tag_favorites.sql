-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- お気に入りタグ（投稿画面のタグパレット）。行が無い人は未同期。
CREATE TABLE IF NOT EXISTS "nagi"."tag_favorites" (
  "did" text PRIMARY KEY NOT NULL,
  "tags" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
