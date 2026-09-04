-- 通常のデプロイは drizzle-kit push なので、このファイルは記録用。
--
-- 印象度。「あとから思い出す価値がどれくらいあるか」を 0-100 で持つ。
--
-- 返信で「この前の話」に触れてよいかを、プロンプトの条件分岐ではなく検索側で
-- 決めるために使う。肯定リプライには既に「過去のポストに直接言及するな」という
-- 明示的な禁止があるので、そこへ条件付きモードを足すのではなく、条件を満たす
-- ときだけコードが1件渡す形にする。
--
-- botMemoryImpressionWorker が印象語の抽出と同じLLM呼び出しで付ける。
-- こっそりにも付く（感情が動く話はこっそりに多い）。ただし印象語は公開出力へ
-- 流れるので、saveBotMemoryImpressions がトランザクション内で visibility を見て
-- 書き分ける。NULL は未評価。
ALTER TABLE "affirmative_bot"."bot_memory_documents"
  ADD COLUMN IF NOT EXISTS "salience" smallint;

ALTER TABLE "affirmative_bot"."bot_memory_documents"
  DROP CONSTRAINT IF EXISTS "bot_memory_salience_range_check";
ALTER TABLE "affirmative_bot"."bot_memory_documents"
  ADD CONSTRAINT "bot_memory_salience_range_check"
  CHECK ("salience" is null or ("salience" >= 0 and "salience" <= 100));
