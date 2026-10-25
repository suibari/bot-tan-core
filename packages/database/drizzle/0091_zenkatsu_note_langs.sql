-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- ゼンカツの「作者の意図」の言語。翻訳の原文言語に使う（投稿の langs と同じ扱い）。
ALTER TABLE "nagi"."zenkatsu_submissions" ADD COLUMN IF NOT EXISTS "note_langs" text[];
