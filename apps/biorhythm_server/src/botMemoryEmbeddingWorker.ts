import {
  createEmbeddingRetryBackoff,
  generateEmbeddings,
  getPendingBotMemoryDocuments,
  isEmbeddingAvailable,
  saveBotMemoryEmbedding,
  type EmbeddingRetryBackoff,
} from "@bsky-affirmative-bot/database";

const BATCH_SIZE = 16;
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 30_000;
let running = false;
// 失敗した行を選び直し続けないための記録。詳細は embeddingRetryBackoff.ts。
const defaultBackoff = createEmbeddingRetryBackoff();

export async function processBotMemoryEmbeddingBatch(
  deps: {
    fetchPending?: typeof getPendingBotMemoryDocuments;
    embed?: typeof generateEmbeddings;
    save?: typeof saveBotMemoryEmbedding;
    available?: () => boolean;
    backoff?: EmbeddingRetryBackoff;
  } = {},
): Promise<number> {
  const fetchPending = deps.fetchPending ?? getPendingBotMemoryDocuments;
  const embed = deps.embed ?? generateEmbeddings;
  const save = deps.save ?? saveBotMemoryEmbedding;
  const available = deps.available ?? (() => isEmbeddingAvailable({ background: true }));
  const backoff = deps.backoff ?? defaultBackoff;
  // cooldown 中に選ぶと、送っていない行まで失敗として記録してしまう。
  if (!available()) return 0;
  const pending = (await fetchPending(BATCH_SIZE + backoff.size()))
    .filter((row) => !backoff.blocked(String(row.id)))
    .slice(0, BATCH_SIZE);
  if (!pending.length) return 0;
  const embeddings = await embed(
    pending.map((row) => row.content),
    { background: true },
  );
  let updated = 0;
  for (let i = 0; i < pending.length; i++) {
    const key = String(pending[i].id);
    const embedding = embeddings[i];
    if (!embedding) {
      backoff.fail(key);
      continue;
    }
    backoff.succeed(key);
    if (await save(
      pending[i].id,
      pending[i].contentHash,
      embedding,
    )) updated++;
  }
  return updated;
}

export function startBotMemoryEmbeddingWorker() {
  if (running) return;
  running = true;
  const loop = async () => {
    let processed = 0;
    try {
      processed = await processBotMemoryEmbeddingBatch();
    } catch (error) {
      console.error("[ERROR][BOT_MEMORY_EMBEDDING]", error);
    }
    const timer = setTimeout(
      () => void loop(),
      processed > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
    );
    timer.unref?.();
  };
  void loop();
}
