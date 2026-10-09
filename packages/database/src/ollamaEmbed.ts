import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import { embeddingProfile } from "./embeddingProfiles.js";
import { expandSearchQuery } from "./queryExpansion.js";

const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * 入力1文字あたりの追加猶予。**タイムアウトを文の長さに比例させるためのもの。**
 *
 * OLLAMA_EMBED_TIMEOUT_MS は「返信前の履歴検索を長時間止めない」ための予算で、
 * クエリ1本を測って決めてある。以前はここを件数比例（1件 1500ms）にしていたが、
 * それは短い投稿（1件 約330ms）が前提だった。web_research の記憶は平均1200字・最大7000字あり、
 * 件数では計算量が見えない。
 *
 * 実測（qwen3-embedding:0.6b / CPU の ollama-embed、2026-10-09）:
 * 1804字 → 1156トークン（0.64 トークン/字）、1524トークン 11.5秒（7.6ms/トークン）。
 * 日本語で約5ms/字。トークン化の悪い文（絵文字・記号）は1字1トークン近くまで行くので、
 * 倍の余裕を見て 10ms/字。
 *
 * 2026-10-09 は件数比例の予算（12件 21.5秒）に長文が乗り、同じ組が毎回時間切れ →
 * cooldown → 同じ組で再び時間切れ、を1日130回繰り返した。時間切れでも Ollama は
 * 処理中の1件を最後まで計算するので、共有している埋め込みサーバをそのぶん塞ぐ。
 */
const DEFAULT_TIMEOUT_PER_CHAR_MS = 10;
/**
 * 1回の送信に載せる合計文字数の上限。**これを超える分は別の送信に分ける。**
 *
 * 埋め込みサーバは OLLAMA_NUM_PARALLEL=1 で bot-tan-convo と共有している。
 * 1回の送信が長いほど、その間ほかの利用者（ふだん0.4秒の問い合わせ）が待たされる。
 * 800字 ≒ 4秒。短い投稿16件（平均85字）ならこれまでどおり1回で済む。
 */
const DEFAULT_MAX_BATCH_CHARS = 800;
/**
 * 1件の入力の上限文字数。超えた分は送らない（先頭だけ埋め込む）。
 *
 * 埋め込みサーバの n_ctx は 4096 で、7000字の記憶は元々サーバ側で切られていた
 * （4096トークン ≒ 30秒）。1500字 ≒ 7秒で打ち切る。人物・記憶の要旨は先頭に来るので、
 * 末尾を落としても検索への影響は小さいと見ている（変えるなら docs/evaluations/embedding/ で測ること）。
 */
const DEFAULT_MAX_INPUT_CHARS = 1_500;
const DEFAULT_COOLDOWN_MS = 60_000;
const EMBEDDING_DIMENSIONS = 1024;

/**
 * cooldown は2系統ある。
 *
 * - unavailableUntil: 利用者を待たせる経路（検索・返信前の履歴）の失敗で開く。
 *   サーバが落ちている合図なので、ワーカーも止める。
 * - backgroundUnavailableUntil: 埋め込みワーカーの失敗で開く。ワーカーだけを止める。
 *
 * 以前は1本で、ワーカーの長文バッチが時間切れになるたび、利用者の検索まで60秒止まっていた。
 */
let unavailableUntil = 0;
let backgroundUnavailableUntil = 0;

export type EmbeddingRequestOptions = {
  /**
   * 埋め込みワーカーからの呼び出し。失敗しても利用者の検索の cooldown は開かない。
   * 利用者が結果を待っている経路では指定しないこと。
   */
  background?: boolean;
};

const positiveEnvNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const nullEmbeddings = (length: number): null[] =>
  Array.from({ length }, () => null);

const clipInput = (text: string): string => {
  const max = positiveEnvNumber("OLLAMA_EMBED_MAX_INPUT_CHARS", DEFAULT_MAX_INPUT_CHARS);
  return text.length > max ? text.slice(0, max) : text;
};

const embeddingBaseUrl = (): string | undefined =>
  process.env.OLLAMA_EMBED_BASE_URL ?? process.env.OLLAMA_BASE_URL;

/**
 * 埋め込みサーバがいま使えるか（設定済みで cooldown 中でない）。
 * ワーカーは、送っていない行を失敗として記録しないよう、行を選ぶ前にこれを見る。
 */
export function isEmbeddingAvailable(opts: EmbeddingRequestOptions = {}): boolean {
  if (!embeddingBaseUrl()) return false;
  const now = Date.now();
  if (now < unavailableUntil) return false;
  return !(opts.background && now < backgroundUnavailableUntil);
}

/**
 * 合計文字数が上限を超えないように、順序を保ったまま送信単位へ分ける。
 * 上限より長い1件は単独の送信になる。
 */
export function splitEmbeddingBatches(texts: string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of texts) {
    if (current.length > 0 && currentChars + text.length > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function requestEmbeddings(
  input: string | string[],
  opts: EmbeddingRequestOptions = {},
): Promise<number[][] | null> {
  const baseUrl = embeddingBaseUrl();
  if (!baseUrl || !isEmbeddingAvailable(opts)) return null;

  // 文の長さに比例させる。短いクエリ1本なら従来どおりの予算のまま。
  const count = Array.isArray(input) ? input.length : 1;
  const chars = Array.isArray(input)
    ? input.reduce((sum, text) => sum + text.length, 0)
    : input.length;
  const timeoutMs = Math.round(
    positiveEnvNumber("OLLAMA_EMBED_TIMEOUT_MS", DEFAULT_TIMEOUT_MS) +
      positiveEnvNumber(
        "OLLAMA_EMBED_TIMEOUT_PER_CHAR_MS",
        DEFAULT_TIMEOUT_PER_CHAR_MS,
      ) *
        chars,
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

    if (opts.background) backgroundUnavailableUntil = 0;
    else unavailableUntil = 0;
    return embeddings as number[][];
  } catch (error) {
    if (opts.background) backgroundUnavailableUntil = Date.now() + cooldownMs;
    else unavailableUntil = Date.now() + cooldownMs;
    console.error(
      `[ERROR][ollamaEmbed] request failed (count=${count}, chars=${chars}, ` +
        `timeout=${timeoutMs}ms, background=${Boolean(opts.background)}); ` +
        `suppressing retries for ${cooldownMs}ms`,
      error,
    );
    return null;
  }
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const embeddings = await requestEmbeddings(clipInput(text));
  return embeddings?.[0] ?? null;
}

/**
 * 検索クエリ用の接頭辞。**文書側には付けない**（クエリ側だけに付けるのが
 * arctic-embed v2.0 / Qwen3-Embedding 両方の設計）。
 *
 * 値は埋め込みモデルと1対1に対応するので embeddingProfiles.ts のテーブルが持つ。
 * env で個別に指定できたころは、モデルだけ差し替えて接頭辞を据え置くと
 * **例外も出ずに検索結果が無意味になる**状態が作れてしまった。
 *
 * 値は scripts/evaluateEmbeddingModels.mts のエンコーダ定義と**一字一句揃える**こと。
 * 揃っていないと評価で出た数字が本番で再現しない。
 */
export function searchQueryPrefix(): string {
  return embeddingProfile().queryPrefix;
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
  opts: {
    /**
     * 別名展開を通す（「まどマギ」→「まどマギ 魔法少女まどか☆マギカ」）。
     * LLM 生成が1回入るので約0.8秒かかる。**あいまい検索のような副次パネル専用**で、
     * タイプアヘッドや botMemory RAG のような即応が要る経路では有効にしないこと。
     * 詳細は queryExpansion.ts。
     */
    expand?: boolean;
  } = {},
): Promise<number[] | null> {
  const t = text.trim();
  if (!t) return null;
  const q = opts.expand ? await expandSearchQuery(t) : t;
  return generateEmbedding(`${searchQueryPrefix()}${q}`);
}

/**
 * 複数の文を埋め込む。合計文字数が OLLAMA_EMBED_MAX_BATCH_CHARS を超えないよう
 * 送信を分けるので、呼び出し側は件数を気にせず渡してよい。
 * 失敗した送信の分は null。失敗で cooldown が開くと、残りの送信も null になる。
 */
export async function generateEmbeddings(
  texts: string[],
  opts: EmbeddingRequestOptions = {},
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const maxChars = positiveEnvNumber(
    "OLLAMA_EMBED_MAX_BATCH_CHARS",
    DEFAULT_MAX_BATCH_CHARS,
  );
  const results: (number[] | null)[] = [];
  for (const batch of splitEmbeddingBatches(texts.map(clipInput), maxChars)) {
    const embeddings = await requestEmbeddings(batch, opts);
    results.push(...(embeddings ?? nullEmbeddings(batch.length)));
  }
  return results;
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
