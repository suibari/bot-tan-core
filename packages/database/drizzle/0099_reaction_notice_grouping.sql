-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 同じ相手・同じ対象へのリアクション通知を5分単位でまとめ、
-- 一度通知した絵文字は付け直しても再通知しない。
ALTER TABLE "nagi"."notifications" ADD COLUMN IF NOT EXISTS "group_key" uuid;
CREATE INDEX IF NOT EXISTS "nagi_notification_group_idx"
  ON "nagi"."notifications" ("recipient_did", "group_key");

CREATE TABLE IF NOT EXISTS "nagi"."reaction_notice_ledger" (
  "recipient_did" text NOT NULL,
  "actor_did" text NOT NULL,
  "subject_uri" text NOT NULL,
  "emoji_key" text NOT NULL,
  "group_id" uuid NOT NULL,
  "notified_at" timestamp with time zone NOT NULL,
  "read_at" timestamp with time zone,
  CONSTRAINT "reaction_notice_ledger_pk"
    PRIMARY KEY ("recipient_did", "actor_did", "subject_uri", "emoji_key")
);
CREATE INDEX IF NOT EXISTS "nagi_reaction_notice_actor_idx"
  ON "nagi"."reaction_notice_ledger" ("actor_did");
CREATE INDEX IF NOT EXISTS "nagi_reaction_notice_subject_idx"
  ON "nagi"."reaction_notice_ledger" ("subject_uri");
