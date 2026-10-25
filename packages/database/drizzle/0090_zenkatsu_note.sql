-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- ゼンカツの「作者の意図」。公開される自由記述なので、判定待ちを note_moderation_version で持つ。
ALTER TABLE "nagi"."zenkatsu_submissions" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "nagi"."zenkatsu_submissions" ADD COLUMN IF NOT EXISTS "note_moderation_labels" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "nagi"."zenkatsu_submissions" ADD COLUMN IF NOT EXISTS "note_moderation_version" text DEFAULT 'legacy';
