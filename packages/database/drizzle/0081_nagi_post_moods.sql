-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 日記の感情グラフ用。投稿ごとの気分を NagiPostMoodWorker が非同期に埋める。
CREATE TABLE IF NOT EXISTS "nagi"."post_moods" (
  "post_uri" text PRIMARY KEY NOT NULL,
  "did" text NOT NULL,
  "cid" text NOT NULL,
  "valence" smallint,
  "expressive" boolean DEFAULT false NOT NULL,
  "version" text NOT NULL,
  "scored_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "nagi_post_moods_valence_range" CHECK ("post_moods"."valence" IS NULL OR "post_moods"."valence" BETWEEN -5 AND 5)
);
CREATE INDEX IF NOT EXISTS "nagi_post_moods_did_idx" ON "nagi"."post_moods" USING btree ("did");
