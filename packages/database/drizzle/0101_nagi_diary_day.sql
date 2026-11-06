-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 日記の「1日」を本人のタイムゾーンと区切りの時刻で決める。どちらも AppView だけが持ち、
-- PDS レコードには書かない。既存データのバックフィルはしない（行の無い人は言語から推定する）。
CREATE TABLE IF NOT EXISTS "nagi"."diary_day_preferences" (
  "did" text PRIMARY KEY NOT NULL,
  "detected_timezone" text,
  "detected_at" timestamp with time zone,
  "manual_timezone" text,
  "start_hour" smallint,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "nagi"."diary_day_schedules" (
  "did" text NOT NULL,
  "effective_from" text NOT NULL,
  "timezone" text NOT NULL,
  "start_hour" smallint NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "diary_day_schedules_did_effective_from_pk" PRIMARY KEY ("did", "effective_from"),
  CONSTRAINT "nagi_diary_day_schedules_start_hour"
    CHECK ("start_hour" BETWEEN 0 AND 6 OR "start_hour" BETWEEN 18 AND 23)
);

-- どの面（Nagi / Bluesky）がその日の日記を書くかの決定と、その実行状態。1人・1日に1行。
-- 両方の bot サーバーが同じ関数で決め、決まった面のサーバーだけが書く（二重に書かない）。
CREATE TABLE IF NOT EXISTS "affirmative_bot"."diary_jobs" (
  "did" text NOT NULL,
  "diary_date" text NOT NULL,
  "surface" text NOT NULL,
  "status" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "timezone" text NOT NULL,
  "start_hour" smallint NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "lease_until" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "diary_jobs_did_diary_date_pk" PRIMARY KEY ("did", "diary_date"),
  CONSTRAINT "diary_jobs_surface_check" CHECK ("surface" in ('nagi', 'bsky', 'none')),
  CONSTRAINT "diary_jobs_status_check"
    CHECK ("status" in ('pending', 'running', 'done', 'skipped', 'expired'))
);
CREATE INDEX IF NOT EXISTS "diary_jobs_surface_status_idx"
  ON "affirmative_bot"."diary_jobs" ("surface", "status");

-- Nagi を使っていない人の日記のタイムゾーンを推定するための、Bluesky の最新の投稿の言語。
ALTER TABLE "affirmative_bot"."followers" ADD COLUMN IF NOT EXISTS "diary_bsky_lang" text;
