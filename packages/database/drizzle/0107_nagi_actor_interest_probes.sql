-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- おすすめフィードの興味の材料（Bluesky 由来の埋め込み）。本文は持たない。
CREATE TABLE IF NOT EXISTS "nagi"."actor_interest_probes" (
  "did" text NOT NULL,
  "position" integer NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "actor_interest_probes_did_position_pk" PRIMARY KEY ("did", "position")
);
