-- モデレーション判定の記録。allow / label / reject を問わず全件残す。
-- 同一 CID・同一ルールバージョンなら再判定しないための冪等キーであり、
-- reject 閾値を実データの分布から決めるための材料でもある。
CREATE TABLE IF NOT EXISTS "nagi"."moderation_decisions" (
  "uri" text PRIMARY KEY NOT NULL,
  "cid" text NOT NULL,
  "did" text NOT NULL,
  "collection" text NOT NULL,
  "decision" text NOT NULL,
  "labels" text[] DEFAULT '{}'::text[] NOT NULL,
  "category" text,
  "score" double precision,
  "rule_version" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nagi_moderation_decisions_did_idx"
  ON "nagi"."moderation_decisions" USING btree ("did");
CREATE INDEX IF NOT EXISTS "nagi_moderation_decisions_decision_idx"
  ON "nagi"."moderation_decisions" USING btree ("decision", "decided_at");

-- 表示側が JOIN せずに読めるよう、判定結果を各テーブルへ非正規化する。
-- moderation_version: NULL=判定待ち / 'skipped'=対象外 / それ以外はルールバージョン。
ALTER TABLE "nagi"."posts"
  ADD COLUMN IF NOT EXISTS "moderation_labels" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "nagi"."posts"
  ADD COLUMN IF NOT EXISTS "moderation_version" text;
-- 未成年ビューアへのフィルタを SQL で書くため、セルフラベルも列として持つ。
ALTER TABLE "nagi"."posts"
  ADD COLUMN IF NOT EXISTS "self_labels" text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE "nagi"."profiles"
  ADD COLUMN IF NOT EXISTS "moderation_labels" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "nagi"."profiles"
  ADD COLUMN IF NOT EXISTS "moderation_version" text;

ALTER TABLE "nagi"."channels"
  ADD COLUMN IF NOT EXISTS "moderation_labels" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "nagi"."channels"
  ADD COLUMN IF NOT EXISTS "moderation_version" text;

ALTER TABLE "nagi"."emojis"
  ADD COLUMN IF NOT EXISTS "moderation_labels" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "nagi"."emojis"
  ADD COLUMN IF NOT EXISTS "moderation_version" text;

ALTER TABLE "nagi"."news"
  ADD COLUMN IF NOT EXISTS "moderation_labels" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "nagi"."news"
  ADD COLUMN IF NOT EXISTS "moderation_version" text;

-- この機能を入れる前からある行はバックフィルしない。判定待ちのまま残すと、
-- 既存レコード全件が一斉に OpenAI へ流れて 429 になるため（開発環境で実際に起きた）。
-- 'legacy' は「未判定だが判定待ちではない」印。編集されて cid が変われば
-- applyMutation が NULL へ戻すので、その時点で判定対象になる。
UPDATE "nagi"."posts"    SET "moderation_version" = 'legacy' WHERE "moderation_version" IS NULL;
UPDATE "nagi"."profiles" SET "moderation_version" = 'legacy' WHERE "moderation_version" IS NULL;
UPDATE "nagi"."channels" SET "moderation_version" = 'legacy' WHERE "moderation_version" IS NULL;
UPDATE "nagi"."emojis"   SET "moderation_version" = 'legacy' WHERE "moderation_version" IS NULL;
UPDATE "nagi"."news"     SET "moderation_version" = 'legacy' WHERE "moderation_version" IS NULL;

-- 判定待ちの行だけを走査するワーカー用。判定が済んだ行は索引に載らない。
-- 上の UPDATE の後に作る（ほぼ空の索引になるので構築が速い）。
CREATE INDEX IF NOT EXISTS "nagi_posts_moderation_pending_idx"
  ON "nagi"."posts" ("indexed_at") WHERE "moderation_version" IS NULL;
CREATE INDEX IF NOT EXISTS "nagi_profiles_moderation_pending_idx"
  ON "nagi"."profiles" ("indexed_at") WHERE "moderation_version" IS NULL;
CREATE INDEX IF NOT EXISTS "nagi_channels_moderation_pending_idx"
  ON "nagi"."channels" ("indexed_at") WHERE "moderation_version" IS NULL;
CREATE INDEX IF NOT EXISTS "nagi_emojis_moderation_pending_idx"
  ON "nagi"."emojis" ("indexed_at") WHERE "moderation_version" IS NULL;
CREATE INDEX IF NOT EXISTS "nagi_news_moderation_pending_idx"
  ON "nagi"."news" ("indexed_at") WHERE "moderation_version" IS NULL;

-- 年齢確認。生年月日は PDS レコードにすると誰でも読めるので AppView だけが持つ。
-- 行が無い／birth_date が NULL なら未成年として扱う。
CREATE TABLE IF NOT EXISTS "nagi"."age_assurance" (
  "did" text PRIMARY KEY NOT NULL,
  "birth_date" date,
  "parental_consent_at" timestamp with time zone,
  "source" text NOT NULL,
  "assured_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- この機能を入れる前からいたユーザーは一律に成人として扱う。
-- 判定待ちのバックフィルが走る前にこれを流しておかないと、既存ユーザーから
-- 既存コンテンツが一時的に見えなくなる。
INSERT INTO "nagi"."age_assurance" ("did", "source")
SELECT "did", 'legacy' FROM "nagi"."profiles"
ON CONFLICT ("did") DO NOTHING;
