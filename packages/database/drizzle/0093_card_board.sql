-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- おすそわけボードと Ƶ（全肯定ポイント）。docs/zenkatsu.md 13章。
ALTER TYPE "nagi"."notification_type" ADD VALUE IF NOT EXISTS 'gift';
DO $$ BEGIN
  CREATE TYPE "nagi"."zenny_ledger_reason" AS ENUM ('donate', 'take', 'shelf', 'welcome');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "nagi"."card_instances" ADD COLUMN IF NOT EXISTS "received_from_did" text;
CREATE TABLE IF NOT EXISTS "nagi"."card_board_stock" (
  "donor_did" text NOT NULL,
  "card_volume" integer NOT NULL,
  "card_number" integer NOT NULL,
  "count" integer NOT NULL,
  CONSTRAINT "card_board_stock_donor_did_card_volume_card_number_pk" PRIMARY KEY ("donor_did", "card_volume", "card_number"),
  CONSTRAINT "nagi_card_board_stock_count_check" CHECK ("card_board_stock"."count" >= 0)
);
CREATE INDEX IF NOT EXISTS "nagi_card_board_stock_card_idx" ON "nagi"."card_board_stock" USING btree ("card_volume", "card_number");
CREATE TABLE IF NOT EXISTS "nagi"."zenny_balances" (
  "did" text PRIMARY KEY NOT NULL,
  "balance" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "nagi_zenny_balances_balance_check" CHECK ("zenny_balances"."balance" >= 0)
);
CREATE TABLE IF NOT EXISTS "nagi"."zenny_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "did" text NOT NULL,
  "delta" integer NOT NULL,
  "reason" "nagi"."zenny_ledger_reason" NOT NULL,
  "card_volume" integer,
  "card_number" integer,
  "quantity" integer DEFAULT 1 NOT NULL,
  "counterparty_did" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "nagi_zenny_ledger_did_idx" ON "nagi"."zenny_ledger" USING btree ("did", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_zenny_ledger_welcome_idx" ON "nagi"."zenny_ledger" USING btree ("did") WHERE "zenny_ledger"."reason" = 'welcome';
