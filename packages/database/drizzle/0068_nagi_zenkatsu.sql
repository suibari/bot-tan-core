-- ゼンカツ！（1日1回、お題に手持ちのカード1〜3枚で答える遊び）。
-- 設計の経緯と理由は docs/zenkatsu.md を参照。
--
-- 提出そのものは**ユーザー自身の PDS レコード**（com.suibari.nagi.zenkatsu）で、
-- ここにあるのはその索引。ドローと違い、提出は「既に所持している札を参照するだけ」なので、
-- 所持・お休み・1日1回のすべてを AppView が取り込み時に照合して弾ける。
-- （ドローは乱数から価値を生むので照合先が無く、PDS 権威にできない。card_instances 参照）
--
-- 通常のデプロイは drizzle-kit push なのでこのファイルは記録用（手で当てる場合の参照）。

-- その日のお題を不変に焼き付ける。お題を「日付 % お題数」で都度計算すると、
-- themes_v{n}.json にお題を足した瞬間に過去の日のお題が全部ずれる。日付パーマリンクで
-- さかのぼれる仕様なのでアーカイブの破壊になる（カード番号の変更禁止と同じクラスの問題）。
-- その日を初めて開いたときに ON CONFLICT DO NOTHING で確定させ、以後は変えない。
CREATE TABLE IF NOT EXISTS "nagi"."zenkatsu_daily" (
  "theme_date" text PRIMARY KEY NOT NULL,
  "theme_volume" integer NOT NULL,
  "theme_number" integer NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "nagi"."zenkatsu_submissions" (
  -- at://did/com.suibari.nagi.zenkatsu/{themeDate}。rkey が日付なので repo 側でも1日1本。
  "uri" text PRIMARY KEY NOT NULL,
  "cid" text NOT NULL,
  "did" text NOT NULL,
  "theme_date" text NOT NULL,
  "theme_volume" integer NOT NULL,
  "theme_number" integer NOT NULL,
  -- botたんの総評。NULL = 生成待ち（UI はコメント無しで先に記録を出す）。
  "comment_ja" text,
  "comment_en" text,
  "comment_model" text,
  "comment_prompt_version" text,
  -- サーバ側で決定論的に計算した「読み」のラベル。プロンプトへ渡すためのものだが、
  -- ニュースの選別（is_highlight）と記録表示でも使い回すので保存する。
  "reading" jsonb NOT NULL,
  "is_highlight" boolean DEFAULT false NOT NULL,
  -- レコードに書かれた値。ユーザーが自由に書けるので並び順には使わない。
  "created_at" timestamp with time zone NOT NULL,
  -- AppView が索引した時刻。新着順はこちらで並べる（created_at は遡れてしまう）。
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- 1日1回・先着のみ。レコードが削除されてもこの行は残すので再提出はできない
-- （「1日1回・確定」を保つ）。
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_zenkatsu_submission_did_date_idx"
  ON "nagi"."zenkatsu_submissions" ("did", "theme_date");
-- 日付ページの新着順ページング。
CREATE INDEX IF NOT EXISTS "nagi_zenkatsu_submission_feed_idx"
  ON "nagi"."zenkatsu_submissions" ("theme_date", "indexed_at", "uri");
-- クールタイム判定（直近7日ぶんの提出を引く）。
CREATE INDEX IF NOT EXISTS "nagi_zenkatsu_submission_owner_idx"
  ON "nagi"."zenkatsu_submissions" ("did", "indexed_at");
-- ニュースタブ。
CREATE INDEX IF NOT EXISTS "nagi_zenkatsu_submission_highlight_idx"
  ON "nagi"."zenkatsu_submissions" ("is_highlight", "indexed_at");

-- 子テーブルに分けるのは、クールタイム判定が「この札を直近 D 日に何回出したか」という
-- 札単位の集計だから。カラムに3枚並べるとこの集計が書けない。
CREATE TABLE IF NOT EXISTS "nagi"."zenkatsu_cards" (
  "submission_uri" text NOT NULL,
  -- 1..3。プレイヤーが置いた順は意味を持つ（総評でも順に読む）ので保つ。
  "position" integer NOT NULL,
  "card_volume" integer NOT NULL,
  "card_number" integer NOT NULL,
  CONSTRAINT "zenkatsu_cards_submission_uri_position_pk"
    PRIMARY KEY ("submission_uri", "position")
);

CREATE INDEX IF NOT EXISTS "nagi_zenkatsu_cards_card_idx"
  ON "nagi"."zenkatsu_cards" ("card_volume", "card_number");

-- botたんの総評を生成するリースキュー（card_comment_jobs と同型）。
-- enqueue は提出レコードを索引した時点、処理は nagi_bot_server の NagiZenkatsuWorker。
-- bot_job_state enum は 0018 以降で既に存在する前提。
CREATE TABLE IF NOT EXISTS "nagi"."zenkatsu_comment_jobs" (
  "submission_uri" text PRIMARY KEY NOT NULL,
  "state" "nagi"."bot_job_state" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nagi_zenkatsu_comment_jobs_ready_idx"
  ON "nagi"."zenkatsu_comment_jobs" ("state", "next_attempt_at");

-- 本人がレコードを消したときは論理削除にする。行ごと消すと、消して出し直せてしまう
-- （zenkatsu_cards まで消えるので出した札のおやすみもリセットされ、
--   気に入る総評が出るまで引き直せる）。行を残せば一意索引が再提出を止める。
ALTER TABLE "nagi"."zenkatsu_submissions"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- ドローの控え（com.suibari.nagi.cardGet）の索引。レコードはユーザー自身の repo にあるが
-- **権威ではなく控え**。card_draws / card_instances と突き合わせて一致しないものは索引しない。
-- ユーザーの repo に置くのは、リアクションの subject(strongRef) が実在の PDS レコードを
-- 要求するから。botたん の repo だと通知の宛先が botたん になってしまう。
CREATE TABLE IF NOT EXISTS "nagi"."card_gets" (
  "uri" text PRIMARY KEY NOT NULL,
  "cid" text NOT NULL,
  "did" text NOT NULL,
  "card_volume" integer NOT NULL,
  "card_number" integer NOT NULL,
  "draw_date" text NOT NULL,
  -- card_draws の enum を広げずに text で持つ（記念日は card_draws を使わない）。
  "source" text NOT NULL,
  "rarity" text NOT NULL,
  -- 照合済みの実際に引いた時刻。ニュースはこれで並べるので、過去ぶんを後から控えても
  -- 今日のニュースには出ない。
  "drawn_at" timestamp with time zone NOT NULL,
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "nagi_card_gets_draw_idx"
  ON "nagi"."card_gets" ("did", "draw_date", "source", "card_volume", "card_number");
CREATE INDEX IF NOT EXISTS "nagi_card_gets_news_idx"
  ON "nagi"."card_gets" ("rarity", "drawn_at");
CREATE INDEX IF NOT EXISTS "nagi_card_gets_owner_idx"
  ON "nagi"."card_gets" ("did", "drawn_at");
