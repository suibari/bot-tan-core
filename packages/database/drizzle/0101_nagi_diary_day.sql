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
