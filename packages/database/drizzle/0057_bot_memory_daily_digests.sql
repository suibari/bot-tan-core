-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- 短期記憶。直近の出来事を1日1行にまとめたダイジェスト。
-- bot_memory_documents へのベクトル検索とは独立に、常時プロンプトへ載せる。
-- 「直近に何があったか」を類似度で引くと、クエリに似ていない出来事が
-- そもそも出てこない（＝直近を忘れる）ため、時間で引ける表を分けている。
--
-- digest_date は JST の "YYYY-MM-DD" 文字列。daily_metrics と同じ表現に揃えて、
-- timestamp encoder を経由しない raw な日付比較を避ける。
CREATE TABLE IF NOT EXISTS "affirmative_bot"."bot_memory_daily_digests" (
  "digest_date" text PRIMARY KEY,
  "summary_ja" text NOT NULL,
  "highlights" jsonb,
  "source_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
