-- botたん由来の識別子を "bottan" に統一する。
-- 通常のデプロイは drizzle-kit push。このSQLは既存行を移す手動適用時の参照用。
DROP INDEX IF EXISTS "nagi"."nagi_zenkatsu_trophies_botan_day_idx";
UPDATE "nagi"."zenkatsu_trophies"
SET "kind" = 'bottan'
WHERE "kind" = 'botan';
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_zenkatsu_trophies_bottan_day_idx"
  ON "nagi"."zenkatsu_trophies" ("theme_date") WHERE "kind" = 'bottan';
