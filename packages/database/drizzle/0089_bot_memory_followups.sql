-- 通常のデプロイは drizzle-kit push。このSQLは手動適用用の記録。
-- 相手が「これからやる」と言ったこと。期日を過ぎたら次の返信で一度だけ聞く。
CREATE TABLE IF NOT EXISTS "affirmative_bot"."bot_memory_followups" (
  "id" serial PRIMARY KEY NOT NULL,
  "document_id" integer NOT NULL,
  "author_id" text NOT NULL,
  "text" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "offered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_memory_followups_document_id_bot_memory_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "affirmative_bot"."bot_memory_documents"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "bot_memory_followup_document_idx" ON "affirmative_bot"."bot_memory_followups" USING btree ("document_id");
CREATE INDEX IF NOT EXISTS "bot_memory_followup_author_due_idx" ON "affirmative_bot"."bot_memory_followups" USING btree ("author_id", "due_at");
