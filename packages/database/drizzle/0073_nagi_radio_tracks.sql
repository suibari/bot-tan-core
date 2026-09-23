CREATE TABLE IF NOT EXISTS "nagi"."radio_tracks" (
  "subject_did" text PRIMARY KEY NOT NULL,
  "slot_key" text NOT NULL,
  "status" text NOT NULL,
  "claimed_at" timestamp with time zone NOT NULL,
  "title" text,
  "artist" text,
  "comment" text,
  "video_id" text,
  "video_title" text,
  "source_url" text,
  "published_at" timestamp with time zone,
  CONSTRAINT "nagi_radio_tracks_status_check" CHECK ("status" IN ('pending', 'ready'))
);
