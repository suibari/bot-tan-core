-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 年表の週次化（2026-11〜）と、年表更新の通知。docs/chronicle.md。
ALTER TYPE "nagi"."notification_type" ADD VALUE IF NOT EXISTS 'chronicle';
ALTER TABLE "nagi"."chronicle_events" ADD COLUMN IF NOT EXISTS "source_week" text;
CREATE INDEX IF NOT EXISTS "nagi_chronicle_events_week_idx"
  ON "nagi"."chronicle_events" ("subject_did", "source_week");
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_week_jobs" (
  "subject_did" text NOT NULL,
  "week_start" text NOT NULL,
  "diary_count" integer NOT NULL,
  "state" "nagi"."bot_job_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("subject_did", "week_start")
);
CREATE INDEX IF NOT EXISTS "nagi_chronicle_week_jobs_ready_idx"
  ON "nagi"."chronicle_week_jobs" ("state", "next_attempt_at");
