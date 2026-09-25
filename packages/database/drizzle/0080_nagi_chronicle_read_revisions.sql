-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_read_revisions" (
  "did" text NOT NULL,
  "revision" text NOT NULL,
  PRIMARY KEY ("did", "revision")
);
