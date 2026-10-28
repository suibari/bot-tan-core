-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 絵文字の生成ジョブ。docs/emoji-generation.md。
ALTER TYPE "nagi"."notification_type" ADD VALUE IF NOT EXISTS 'emoji';
DO $$ BEGIN
  CREATE TYPE "nagi"."emoji_generation_state" AS ENUM ('queued', 'running', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "nagi"."emoji_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "did" text NOT NULL,
  "prompt" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "subject" text NOT NULL,
  "lettering" text,
  "aspect" text NOT NULL,
  "outfit" text DEFAULT 'none' NOT NULL,
  "state" "nagi"."emoji_generation_state" DEFAULT 'queued' NOT NULL,
  "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL
);
CREATE INDEX IF NOT EXISTS "nagi_emoji_generations_did_idx" ON "nagi"."emoji_generations" USING btree ("did", "created_at");
CREATE INDEX IF NOT EXISTS "nagi_emoji_generations_queue_idx" ON "nagi"."emoji_generations" USING btree ("state", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_emoji_generations_active_idx" ON "nagi"."emoji_generations" USING btree ("did") WHERE "emoji_generations"."state" in ('queued', 'running');
