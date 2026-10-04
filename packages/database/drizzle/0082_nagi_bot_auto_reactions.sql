-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- botたんの「最初の1件」リアクションの予定表。NagiAutoReactionWorker が積んで処理する。
CREATE TABLE IF NOT EXISTS "nagi"."bot_auto_reactions" (
  "subject_uri" text PRIMARY KEY NOT NULL,
  "subject_cid" text NOT NULL,
  "subject_did" text NOT NULL,
  "kind" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "scheduled_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "reaction_uri" text,
  "emoji_key" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "nagi_bot_auto_reactions_ready_idx" ON "nagi"."bot_auto_reactions" USING btree ("state","scheduled_at","lease_expires_at");
CREATE INDEX IF NOT EXISTS "nagi_bot_auto_reactions_recipient_idx" ON "nagi"."bot_auto_reactions" USING btree ("subject_did","state","updated_at");
