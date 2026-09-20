-- 部長賞だけは1日1人。他の賞は提出時に条件を満たした人全員へ贈る。
-- 通常のデプロイは drizzle-kit push。このSQLは手動適用時の参照用。
-- (theme_date, kind, did) の一意制約は残し、1人に同じ賞が重複しないようにする。
DROP INDEX IF EXISTS "nagi"."nagi_zenkatsu_trophies_day_kind_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "nagi_zenkatsu_trophies_botan_day_idx"
  ON "nagi"."zenkatsu_trophies" ("theme_date") WHERE "kind" = 'botan';
