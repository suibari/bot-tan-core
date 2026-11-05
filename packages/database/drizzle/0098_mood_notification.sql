-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 新しく始めた人の最初の気持ちが感情グラフに載ったことの通知。
ALTER TYPE "nagi"."notification_type" ADD VALUE IF NOT EXISTS 'mood';
