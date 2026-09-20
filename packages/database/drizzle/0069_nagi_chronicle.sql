-- 自分年表（Chronicle）。設計の経緯と理由は docs/chronicle.md を参照。
--
-- ここに入るのは **LLM が書いたイベントだけ**。記念日カード・「はじめて」の記録・
-- Nagi にやってきた日・botたんと出会った日・本人が反応したニュースは行にしない。
-- あれらは card_instances / diaries / profiles / followers / reactions / bookmarks が
-- 権威で、コピーすると年表だけが古い事実を持ち続ける。getChronicle が読み取り時に合流させる。
--
-- 通常のデプロイは drizzle-kit push なのでこのファイルは記録用（手で当てる場合の参照）。

-- 月ごと丸ごと置換できる形。dedupe_key は月内で閉じた鍵（'llm:2026-08:0' / 'news:2026-08'）で、
-- 書き終わりに source_month が同じで今回の鍵に無い行を消す。
-- UNIQUE だけだと「前回3件・今回1件」で余りが残る。
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_did" text NOT NULL,
  -- ユーザーのローカル日付。diaries.diary_date と同じく text で持つ
  -- （AGENTS.md の「raw SQL へ Date を補間しない」方針に揃える）。
  "event_date" text NOT NULL,
  -- 'highlight' | 'news_context'。enum にしないのは種別追加のたびに ALTER TYPE を
  -- 挟みたくないため（card_gets.source と同じ割り切り）。
  "kind" text NOT NULL,
  "source_month" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "title_ja" text NOT NULL,
  "title_en" text NOT NULL,
  "detail_ja" text,
  "detail_en" text,
  -- 日記からの逐語抜粋。表示しない（取り込み時の幻覚チェックと、後からの突き合わせ用）。
  "evidence" text,
  "diary_uri" text,
  "news_uri" text,
  "model" text,
  "prompt_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "nagi_chronicle_events_dedupe_idx"
  ON "nagi"."chronicle_events" ("subject_did", "dedupe_key");
CREATE INDEX IF NOT EXISTS "nagi_chronicle_events_timeline_idx"
  ON "nagi"."chronicle_events" ("subject_did", "event_date");
CREATE INDEX IF NOT EXISTS "nagi_chronicle_events_month_idx"
  ON "nagi"."chronicle_events" ("subject_did", "source_month");

-- 月次ロールアップのリースキュー。zenkatsu_comment_jobs と同型。
-- 「日記はあるが chronicle_events が無い月」を毎 tick 導出する方式にしないのは失敗の記憶が
-- 無いからで、常に失敗する月ができるとそれを毎分 Ollama へ投げ続ける。
-- diary_count が現在件数と食い違ったら pending へ戻して月ごと作り直す。
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_jobs" (
  "subject_did" text NOT NULL,
  "month" text NOT NULL,
  "diary_count" integer NOT NULL,
  "state" "nagi"."bot_job_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "nagi_chronicle_jobs_pkey" PRIMARY KEY ("subject_did", "month")
);

CREATE INDEX IF NOT EXISTS "nagi_chronicle_jobs_ready_idx"
  ON "nagi"."chronicle_jobs" ("state", "next_attempt_at");

-- 年表の「そのころ世の中では」。**月ごとに1行で、全ユーザー共通。**
-- 利用者ごとに持たないのは、これが「その月に世の中で何があったか」であって
-- その人に関係のある話ではないから。同じ事実を人数分複製しても意味が無く、
-- LLM の呼び出しも【人数 × 月】ではなく【月】だけで済む。
-- この表そのものがジョブでもある（月は高々12行/年なので別表を立てない）。
CREATE TABLE IF NOT EXISTS "nagi"."chronicle_news" (
  "month" text PRIMARY KEY NOT NULL,
  -- NULL のまま state='posted' なら「その月は選ばなかった」＝正常。
  "news_uri" text,
  "title_ja" text,
  "title_en" text,
  "candidate_count" integer DEFAULT 0 NOT NULL,
  "state" "nagi"."bot_job_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "model" text,
  "prompt_version" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nagi_chronicle_news_ready_idx"
  ON "nagi"."chronicle_news" ("state", "next_attempt_at");
