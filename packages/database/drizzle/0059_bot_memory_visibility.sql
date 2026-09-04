-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- こっそり投稿も記憶するための可視範囲。
--
-- これまで Nagi のこっそりは bot_memory_documents へ入れていなかったので、
-- 「その人とこっそりで話したこと」を botたん が何も覚えていなかった。覚えるようにし、
-- 代わりに引ける範囲をこの列で持つ:
--   public  … 誰との会話でも思い出してよい。定期ポスト・ダッシュボードにも出せる
--   kossori … 本人がこっそりで話しているときだけ。公開出力には一切出さない
--
-- 既定を public にしてあるので、既存行はそのまま公開扱いで動く（バックフィル不要）。
ALTER TABLE "affirmative_bot"."bot_memory_documents"
  ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;

ALTER TABLE "affirmative_bot"."bot_memory_documents"
  DROP CONSTRAINT IF EXISTS "bot_memory_visibility_check";
ALTER TABLE "affirmative_bot"."bot_memory_documents"
  ADD CONSTRAINT "bot_memory_visibility_check"
  CHECK ("visibility" in ('public', 'kossori'));

CREATE INDEX IF NOT EXISTS "bot_memory_visibility_occurred_idx"
  ON "affirmative_bot"."bot_memory_documents" ("visibility", "occurred_at");
