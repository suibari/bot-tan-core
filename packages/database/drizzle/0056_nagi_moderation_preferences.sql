CREATE TABLE IF NOT EXISTS "nagi"."moderation_preferences" (
	"did" text PRIMARY KEY NOT NULL,
	"automatic" text NOT NULL,
	"self_ai" text NOT NULL,
	"self_nsfw" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nagi_moderation_preferences_values_check"
		CHECK (
			"automatic" IN ('warn', 'hide', 'ignore')
			AND "self_ai" IN ('warn', 'hide', 'ignore')
			AND "self_nsfw" IN ('warn', 'hide', 'ignore')
		)
);

CREATE INDEX IF NOT EXISTS "nagi_moderation_preferences_updated_idx"
	ON "nagi"."moderation_preferences" ("updated_at");
