ALTER TABLE "affirmative_bot"."bot_song_selections"
  ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'published' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reservation_expires_at" timestamp with time zone;

ALTER TABLE "affirmative_bot"."bot_song_selections"
  DROP CONSTRAINT IF EXISTS "bot_song_selection_status_check";
ALTER TABLE "affirmative_bot"."bot_song_selections"
  ADD CONSTRAINT "bot_song_selection_status_check"
  CHECK ("status" IN ('reserved', 'publishing', 'published'));

ALTER TABLE "affirmative_bot"."bot_song_selections"
  DROP CONSTRAINT IF EXISTS "bot_song_selection_reservation_check";
ALTER TABLE "affirmative_bot"."bot_song_selections"
  ADD CONSTRAINT "bot_song_selection_reservation_check"
  CHECK (
    ("status" IN ('reserved', 'publishing') AND "reservation_expires_at" IS NOT NULL)
    OR ("status" = 'published' AND "reservation_expires_at" IS NULL)
  );

CREATE INDEX IF NOT EXISTS "bot_song_selection_reservation_expiry_idx"
  ON "affirmative_bot"."bot_song_selections" ("status", "reservation_expires_at");
