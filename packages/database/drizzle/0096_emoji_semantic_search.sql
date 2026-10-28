-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 絵文字の意味検索。カスタム絵文字の読み取り文と埋め込み、Unicode 絵文字の検索表。
-- embedding に HNSW は張らない（千単位の行は厳密計算で足り、近似だと近い行を取りこぼす）。
ALTER TABLE "nagi"."emojis" ADD COLUMN IF NOT EXISTS "search_text" text;
ALTER TABLE "nagi"."emojis" ADD COLUMN IF NOT EXISTS "search_text_cid" text;
ALTER TABLE "nagi"."emojis" ADD COLUMN IF NOT EXISTS "embedding" vector(1024);

CREATE TABLE IF NOT EXISTS "nagi"."unicode_emojis" (
  "emoji" text PRIMARY KEY NOT NULL,
  "label_ja" text NOT NULL,
  "label_en" text NOT NULL,
  "labels" text NOT NULL,
  "keywords" text NOT NULL,
  "sort_order" integer NOT NULL,
  "embed_text" text NOT NULL,
  "embedding" vector(1024),
  "data_version" text NOT NULL
);
