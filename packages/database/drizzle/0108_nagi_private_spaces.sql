-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 非公開データの正本の置き場所（ATproto Spaces 移行）。行が無い人は appview。
CREATE TABLE IF NOT EXISTS "nagi"."private_spaces" (
  "did" text PRIMARY KEY NOT NULL,
  "storage" text NOT NULL,
  "space_uri" text NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "nagi_private_spaces_storage_check" CHECK ("storage" IN ('appview', 'migrating', 'space'))
);
CREATE INDEX IF NOT EXISTS "nagi_private_spaces_storage_idx" ON "nagi"."private_spaces" ("storage", "changed_at");
