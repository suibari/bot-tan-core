-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 未公開だったリビジョン集合方式を置き換える。1年につき1行だけを保持する。
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_read_years" (
  "did" text NOT NULL,
  "year" integer NOT NULL,
  "revision" text NOT NULL,
  CONSTRAINT "chronicle_read_years_did_year_pk" PRIMARY KEY ("did", "year")
);
