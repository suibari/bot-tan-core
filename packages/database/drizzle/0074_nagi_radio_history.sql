-- 既存の1件を保持したまま、放送枠ごとの履歴へ移行する。
ALTER TABLE "nagi"."radio_tracks" DROP CONSTRAINT IF EXISTS "radio_tracks_pkey";
ALTER TABLE "nagi"."radio_tracks"
  ADD CONSTRAINT "radio_tracks_pkey" PRIMARY KEY ("subject_did", "slot_key");
CREATE INDEX IF NOT EXISTS "nagi_radio_tracks_history_idx"
  ON "nagi"."radio_tracks" ("subject_did", "slot_key");

CREATE TABLE IF NOT EXISTS "nagi"."radio_read_states" (
  "subject_did" text PRIMARY KEY NOT NULL,
  "last_seen_slot_key" text NOT NULL
);
