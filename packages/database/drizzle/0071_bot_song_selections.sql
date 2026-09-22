CREATE TABLE IF NOT EXISTS "affirmative_bot"."bot_song_selections" (
  "id" serial PRIMARY KEY,
  "video_id" text NOT NULL,
  "song_key" text NOT NULL,
  "title" text NOT NULL,
  "artist" text NOT NULL,
  "source" text NOT NULL,
  "output_ref" text,
  "selected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_song_selection_source_check" CHECK ("source" IN ('scheduled_post', 'dj'))
);

CREATE INDEX IF NOT EXISTS "bot_song_selection_video_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("video_id", "selected_at");
CREATE INDEX IF NOT EXISTS "bot_song_selection_key_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("song_key", "selected_at");
CREATE INDEX IF NOT EXISTS "bot_song_selection_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("selected_at");
