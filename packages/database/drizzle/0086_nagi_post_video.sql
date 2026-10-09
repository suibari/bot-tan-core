-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- Nagi 投稿の動画（com.suibari.nagi.post#video、または #quote の video）。
-- 画像の embed_images と同じく、レコードの値をそのまま持つ。
ALTER TABLE "nagi"."posts" ADD COLUMN IF NOT EXISTS "embed_video" jsonb;
