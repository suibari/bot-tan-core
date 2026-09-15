-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- 本人からの依頼は1日1枚制限を外し、同じ投稿の再処理だけを冪等化する。
-- Nagi の自動プレゼントは kind=gift で分け、1人1日1枚を維持する。
-- day は引き続き面ごとのサービス上限の集計に使う。

UPDATE "affirmative_bot"."drawing_claims"
SET "source_uri" = 'legacy:' || "did" || ':' || "day"
WHERE "source_uri" IS NULL;

ALTER TABLE "affirmative_bot"."drawing_claims"
  DROP CONSTRAINT "drawing_claims_surface_did_day_pk";

ALTER TABLE "affirmative_bot"."drawing_claims"
  ALTER COLUMN "source_uri" SET NOT NULL;

ALTER TABLE "affirmative_bot"."drawing_claims"
  ADD COLUMN "kind" text DEFAULT 'request' NOT NULL;

ALTER TABLE "affirmative_bot"."drawing_claims"
  ADD CONSTRAINT "drawing_claims_surface_source_uri_day_pk"
  PRIMARY KEY ("surface", "source_uri", "day");

ALTER TABLE "affirmative_bot"."drawing_claims"
  ADD CONSTRAINT "drawing_claims_kind_check" CHECK ("kind" IN ('request', 'gift'));
