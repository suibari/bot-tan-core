-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- アドベントカレンダー（12/1〜12/25）。botたんが毎日1枚、みんなのポストからカードを選ぶ。
ALTER TYPE "nagi"."notification_type" ADD VALUE IF NOT EXISTS 'advent';

CREATE TABLE IF NOT EXISTS "nagi"."advent_cards" (
  "year" integer NOT NULL,
  "day" integer NOT NULL,
  "did" text NOT NULL,
  "post_uri" text NOT NULL,
  "post_cid" text NOT NULL,
  "title_ja" text NOT NULL,
  "title_en" text NOT NULL,
  "comment_ja" text NOT NULL,
  "comment_en" text NOT NULL,
  "display_name" text NOT NULL,
  "handle" text NOT NULL,
  "avatar_cid" text,
  "publish_at" timestamp with time zone NOT NULL,
  "notified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "advent_cards_year_day_pk" PRIMARY KEY ("year", "day")
);
CREATE INDEX IF NOT EXISTS "nagi_advent_cards_did_idx" ON "nagi"."advent_cards" ("did");
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_advent_cards_post_idx" ON "nagi"."advent_cards" ("post_uri");

CREATE TABLE IF NOT EXISTS "nagi"."advent_rejections" (
  "year" integer NOT NULL,
  "post_uri" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "advent_rejections_year_post_uri_pk" PRIMARY KEY ("year", "post_uri")
);

CREATE TABLE IF NOT EXISTS "nagi"."advent_jobs" (
  "year" integer NOT NULL,
  "day" integer NOT NULL,
  "state" "nagi"."bot_job_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "advent_jobs_year_day_pk" PRIMARY KEY ("year", "day")
);

CREATE TABLE IF NOT EXISTS "nagi"."advent_read_states" (
  "did" text NOT NULL,
  "year" integer NOT NULL,
  "last_seen_day" integer DEFAULT 0 NOT NULL,
  "opened_days" integer[] DEFAULT '{}' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "advent_read_states_did_year_pk" PRIMARY KEY ("did", "year")
);
