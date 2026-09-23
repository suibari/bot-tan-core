CREATE TABLE IF NOT EXISTS "affirmative_bot"."bot_song_selections" (
  "id" serial PRIMARY KEY,
  "video_id" text NOT NULL,
  "song_key" text NOT NULL,
  "title" text NOT NULL,
  "artist" text NOT NULL,
  "purpose" text NOT NULL,
  "subject_did" text,
  "output_ref" text,
  "selected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_song_selection_purpose_check" CHECK ("purpose" IN ('scheduled_post', 'dj')),
  CONSTRAINT "bot_song_selection_scope_check" CHECK (
    ("purpose" = 'scheduled_post' AND "subject_did" IS NULL)
    OR ("purpose" = 'dj' AND "subject_did" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "bot_song_selection_video_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("purpose", "subject_did", "video_id", "selected_at");
CREATE INDEX IF NOT EXISTS "bot_song_selection_key_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("purpose", "subject_did", "song_key", "selected_at");
CREATE INDEX IF NOT EXISTS "bot_song_selection_selected_idx"
  ON "affirmative_bot"."bot_song_selections" ("selected_at");
