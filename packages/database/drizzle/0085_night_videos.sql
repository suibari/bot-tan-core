-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 夜の動画（bot-tan-youtuber が 18:00 に Bluesky へ投稿）を、おやすみポストへ渡すためのテーブル。
CREATE TABLE IF NOT EXISTS "affirmative_bot"."night_videos" (
  "id" serial PRIMARY KEY NOT NULL,
  "video_date" text NOT NULL,
  "post_uri" text NOT NULL,
  "post_cid" text NOT NULL,
  "hook" text,
  "caption" text,
  "source_network" text,
  "source_uri" text,
  "source_display_name" text,
  "themes" jsonb,
  "status" text DEFAULT 'new' NOT NULL,
  "introduced_uri" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "night_videos_video_date_unique" UNIQUE("video_date")
);
