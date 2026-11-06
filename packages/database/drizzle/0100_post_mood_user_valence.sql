-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 感情グラフの点を本人が直せるようにする。LLM の valence とは別の列に持つ。
ALTER TABLE "nagi"."post_moods" ADD COLUMN IF NOT EXISTS "user_valence" smallint;
ALTER TABLE "nagi"."post_moods" ADD COLUMN IF NOT EXISTS "user_edited_at" timestamp with time zone;
ALTER TABLE "nagi"."post_moods" DROP CONSTRAINT IF EXISTS "nagi_post_moods_user_valence_range";
ALTER TABLE "nagi"."post_moods" ADD CONSTRAINT "nagi_post_moods_user_valence_range"
  CHECK ("user_valence" IS NULL OR ("user_valence" BETWEEN -5 AND 5 AND "user_valence" <> 0));
