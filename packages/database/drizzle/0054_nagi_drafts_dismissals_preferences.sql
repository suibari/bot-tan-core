CREATE TABLE IF NOT EXISTS "nagi"."drafts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "owner_did" text NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
CREATE INDEX IF NOT EXISTS "nagi_drafts_owner_updated_idx"
  ON "nagi"."drafts" ("owner_did", "updated_at");

CREATE TABLE IF NOT EXISTS "nagi"."community_affirmation_dismissals" (
  "viewer_did" text NOT NULL,
  "source_uri" text NOT NULL,
  "dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "community_affirmation_dismissals_viewer_did_source_uri_pk"
    PRIMARY KEY ("viewer_did", "source_uri"),
  CONSTRAINT "community_affirmation_dismissals_source_uri_posts_uri_fk"
    FOREIGN KEY ("source_uri") REFERENCES "nagi"."posts"("uri") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "nagi_community_dismissals_expiry_idx"
  ON "nagi"."community_affirmation_dismissals" ("expires_at");

CREATE TABLE IF NOT EXISTS "nagi"."language_preferences" (
  "did" text PRIMARY KEY NOT NULL,
  "post_language" text NOT NULL,
  "translation_language" text NOT NULL,
  "translation_provider" text NOT NULL,
  "auto_translate" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "nagi_language_preferences_updated_idx"
  ON "nagi"."language_preferences" ("updated_at");

CREATE TABLE IF NOT EXISTS "nagi"."bookmark_preferences" (
  "did" text PRIMARY KEY NOT NULL,
  "last_folder_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bookmark_preferences_last_folder_id_bookmark_folders_id_fk"
    FOREIGN KEY ("last_folder_id") REFERENCES "nagi"."bookmark_folders"("id")
    ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "nagi_bookmark_preferences_updated_idx"
  ON "nagi"."bookmark_preferences" ("updated_at");
