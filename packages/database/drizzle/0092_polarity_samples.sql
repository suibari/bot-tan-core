-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 定型リプ3値分類を埋め込み＋軽い分類器へ移すための教師データ。本文と DID は持たない。
CREATE TABLE IF NOT EXISTS "affirmative_bot"."polarity_samples" (
  "id" serial PRIMARY KEY NOT NULL,
  "content_hash" text NOT NULL,
  "language_name" text NOT NULL,
  "label" text NOT NULL,
  "label_model" text NOT NULL,
  "label_version" text NOT NULL,
  "embedding_model" text NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "text_chars" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "polarity_samples_label_check" CHECK ("polarity_samples"."label" in ('positive', 'neutral', 'negative'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "polarity_samples_hash_model_idx" ON "affirmative_bot"."polarity_samples" USING btree ("content_hash","embedding_model");
