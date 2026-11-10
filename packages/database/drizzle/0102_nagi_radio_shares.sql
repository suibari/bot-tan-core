-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- botたんラジオの公開（com.suibari.nagi.radio）の索引。曲とDJコメントは radio_tracks から引く。
CREATE TABLE IF NOT EXISTS "nagi"."radio_shares" (
  "uri" text PRIMARY KEY NOT NULL,
  "cid" text NOT NULL,
  "did" text NOT NULL,
  "slot_key" text NOT NULL,
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "nagi_radio_shares_did_idx" ON "nagi"."radio_shares" USING btree ("did");
