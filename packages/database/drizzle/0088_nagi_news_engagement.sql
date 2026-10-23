-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- my Nagi に1件だけ出すニュースを選ぶための「話しやすさ」（0〜4）。
-- 既存の承認は null のまま（選定では最下位扱い）。新しい承認から審査ゲートが付ける。
ALTER TABLE "nagi"."news_approvals" ADD COLUMN IF NOT EXISTS "talk_score" integer;

-- ニュースのパーマリンクに引用コメントを並べるための索引。
CREATE INDEX IF NOT EXISTS "nagi_posts_quote_idx" ON "nagi"."posts" USING btree ("quote_uri", "indexed_at");
