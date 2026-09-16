ALTER TABLE "nagi"."news_approvals"
ADD COLUMN IF NOT EXISTS "snapshot_image_url" text;

ALTER TABLE "nagi"."news_candidates"
ADD COLUMN IF NOT EXISTS "image_url" text;
