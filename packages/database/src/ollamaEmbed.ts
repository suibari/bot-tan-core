import { aiModel } from "@bsky-affirmative-bot/shared-configs";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const EMBEDDING_DIMENSIONS = 1024;

let unavailableUntil = 0;

const positiveEnvNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const nullEmbeddings = (length: number): null[] =>
  Array.from({ length }, () => null);

async function requestEmbeddings(
  input: string | string[],
): Promise<number[][] | null> {
  const baseUrl = process.env.OLLAMA_EMBED_BASE_URL ?? process.env.OLLAMA_BASE_URL;
  if (!baseUrl || Date.now() < unavailableUntil) return null;

  const timeoutMs = positiveEnvNumber(
    "OLLAMA_EMBED_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const cooldownMs = positiveEnvNumber(
    "OLLAMA_EMBED_COOLDOWN_MS",
    DEFAULT_COOLDOWN_MS,
  );

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: aiModel("OLLAMA_EMBED"), input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json() as any;
    if (!Array.isArray(data?.data)) {
      throw new Error("Unexpected embedding response: data is not an array");
    }

    const expectedLength = Array.isArray(input) ? input.length : 1;
    if (data.data.length !== expectedLength) {
      throw new Error(
        `Unexpected embedding count: expected=${expectedLength}, actual=${data.data.length}`,
      );
    }

    const embeddings = data.data.map((item: any) => item?.embedding);
    if (!embeddings.every(
      (embedding: unknown) =>
        Array.isArray(embedding) && embedding.length === EMBEDDING_DIMENSIONS,
    )) {
      throw new Error("Unexpected embedding shape");
    }

    unavailableUntil = 0;
    return embeddings as number[][];
  } catch (error) {
    unavailableUntil = Date.now() + cooldownMs;
    console.error(
      `[ERROR][ollamaEmbed] request failed; suppressing retries for ${cooldownMs}ms`,
      error,
    );
    return null;
  }
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const embeddings = await requestEmbeddings(text);
  return embeddings?.[0] ?? null;
}

/**
 * 検索クエリ用の接頭辞。**文書側には付けない**（クエリ側だけに付けるのが
 * arctic-embed v2.0 / Qwen3-Embedding 両方の設計）。
 *
 * Qwen3-Embedding の instruction は "Instruct: ...\nQuery: " という形で改行を含む。
 * .env に**二重引用符**で書けば dotenv も `node --env-file` も `\n` を実改行へ展開する
 * （単引用符だと展開されない）。ただし systemd の `Environment=` や docker の `-e` は
 * 展開しないので、`\n` の2文字が残っていた場合の保険としてここでも展開しておく。
 *
 * 値は scripts/evaluateEmbeddingModels.mts のエンコーダ定義と**一字一句揃える**こと。
 * 揃っていないと評価で出た数字が本番で再現しない。
 */
export function searchQueryPrefix(): string {
  return (process.env.OLLAMA_QUERY_PREFIX ?? "").replace(/\\n/g, "\n");
}

/**
 * 検索クエリを埋め込む。文書側の generateEmbedding とは接頭辞の扱いが違うので分けてある。
 *
 * 使い分け:
 *   embedSearchQuery … 利用者が打った検索語（Nagi 検索・botMemory RAG）
 *   generateEmbedding … 投稿・プロフィール・記憶などの**文書本文**
 *
 * 文書側にクエリ接頭辞を付けると、接頭辞そのものが本文として埋め込まれて
 * 全文書のベクトルが同じ方向へ寄る。逆にクエリ側に付け忘れると、
 * instruction-aware なモデル（Qwen3-Embedding など）の精度が出ない。
 */
export async function embedSearchQuery(
  text: string,
): Promise<number[] | null> {
  const t = text.trim();
  return t ? generateEmbedding(`${searchQueryPrefix()}${t}`) : null;
}

export async function generateEmbeddings(
  texts: string[],
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const embeddings = await requestEmbeddings(texts);
  return embeddings ?? nullEmbeddings(texts.length);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function filterRelatedHistory(
  queryText: string,
  candidates: string[],
  topN: number = 10,
  minSim: number = 0,
  fallback: "head" | "empty" = "head",
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const embeddings = await generateEmbeddings([queryText, ...candidates]);
  const queryEmb = embeddings[0];

  if (!queryEmb) {
    console.warn(
      `[WARN][filterRelatedHistory] embedding unavailable, fallback=${fallback}`,
    );
    return fallback === "head" ? candidates.slice(0, topN) : [];
  }

  const ranked = candidates
    .map((text, i) => ({ text, sim: embeddings[i + 1] ? cosineSim(queryEmb, embeddings[i + 1]!) : 0 }))
    .filter(r => r.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topN);

  console.log(`[DEBUG][filterRelatedHistory] ${candidates.length}件中${ranked.length}件が閾値(${minSim})以上、上位${topN}件を選択`);
  ranked.forEach((r, i) => console.log(`  [${i}] sim=${r.sim.toFixed(3)} "${r.text.slice(0, 40)}..."`));

  return ranked.map(x => x.text);
}
