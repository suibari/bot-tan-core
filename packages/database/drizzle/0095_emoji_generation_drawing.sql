-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 書く文字の横に絵も描く絵文字の印。docs/emoji-generation.md。
ALTER TABLE "nagi"."emoji_generations" ADD COLUMN IF NOT EXISTS "drawing" boolean DEFAULT false NOT NULL;
