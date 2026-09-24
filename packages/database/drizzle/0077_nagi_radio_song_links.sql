ALTER TABLE "nagi"."radio_tracks" ADD COLUMN IF NOT EXISTS "song_url" text;
ALTER TABLE "nagi"."radio_tracks" ADD COLUMN IF NOT EXISTS "thumbnail_url" text;
ALTER TABLE "affirmative_bot"."bot_song_selections" ALTER COLUMN "video_id" DROP NOT NULL;
