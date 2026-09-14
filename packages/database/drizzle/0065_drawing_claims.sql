-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- botたんのお絵描き（Bluesky の依頼 / Nagi の依頼と贈り物）の日次枠。
-- 面（surface）ごとに1人1日1枚。day は JST の "YYYY-MM-DD" で、枠の判定に日時の型を使わない。

CREATE TABLE IF NOT EXISTS "affirmative_bot"."drawing_claims" (
  "surface" text NOT NULL,
  "did" text NOT NULL,
  "day" text NOT NULL,
  "source_uri" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "drawing_claims_surface_did_day_pk" PRIMARY KEY ("surface", "did", "day")
);

CREATE INDEX IF NOT EXISTS "drawing_claims_surface_day_idx"
  ON "affirmative_bot"."drawing_claims" ("surface", "day");
