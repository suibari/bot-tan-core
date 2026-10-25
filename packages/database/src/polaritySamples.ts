import { createHash } from "node:crypto";
import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import { db, polarity_samples } from "./db.js";
import { generateEmbeddings, isEmbeddingAvailable } from "./ollamaEmbed.js";

/**
 * 定型リプの3値分類の教師データを、返信の流れを止めずにためる。
 *
 * 1日3,000件を超える分類のたびに埋め込みを1回ずつ送ると、bot-tan-convo と共有している
 * 埋め込みサーバ（OLLAMA_NUM_PARALLEL=1）を細切れに塞ぐ。手元にためて
 * FLUSH_SIZE 件か FLUSH_DELAY_MS 経過でまとめて送る（短い投稿16件なら1回の送信で済む）。
 *
 * 教師データは取りこぼしても困らない。プロセス終了時の未送信分も、埋め込みの失敗も捨てる。
 */

export type PolaritySampleLabel = "positive" | "neutral" | "negative";

export type PolaritySampleInput = {
  text: string;
  languageName: string;
  label: PolaritySampleLabel;
  /** 分類プロンプトの版。プロンプトを変えたら呼び出し側で上げる。 */
  labelVersion: string;
};

const FLUSH_SIZE = 16;
const FLUSH_DELAY_MS = 60_000;
/** 埋め込みサーバが落ちているあいだに溜め込みすぎない。 */
const MAX_PENDING = 256;

let pending: PolaritySampleInput[] = [];
let timer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | undefined;

/**
 * 積む割合（0〜1）。`POLARITY_SAMPLE_RATE=0` で止める。未設定は全件。
 * 必要な件数がたまったら 0 にして止めること。
 */
export function polaritySampleRate(): number {
  const raw = process.env.POLARITY_SAMPLE_RATE?.trim();
  if (!raw) return 1;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function polaritySampleHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

export function recordPolaritySample(
  input: PolaritySampleInput,
  random: () => number = Math.random,
): void {
  if (!input.text.trim()) return;
  const rate = polaritySampleRate();
  if (rate <= 0 || random() >= rate) return;
  if (pending.length >= MAX_PENDING) return;
  pending.push(input);
  if (pending.length >= FLUSH_SIZE) {
    void flushPolaritySamples();
    return;
  }
  if (!timer) {
    timer = setTimeout(() => void flushPolaritySamples(), FLUSH_DELAY_MS);
    timer.unref();
  }
}

/** 溜まっている分を送る。テストと終了処理から呼べるよう公開している。 */
export async function flushPolaritySamples(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  // 前の送信が終わるまで待つ。埋め込みサーバへの送信を重ねない。
  while (flushing) await flushing;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  flushing = writeBatch(batch).finally(() => {
    flushing = undefined;
  });
  await flushing;
}

async function writeBatch(batch: PolaritySampleInput[]): Promise<void> {
  try {
    if (!isEmbeddingAvailable({ background: true })) return;
    const embeddings = await generateEmbeddings(
      batch.map((sample) => sample.text.trim()),
      { background: true },
    );
    const embeddingModel = aiModel("OLLAMA_EMBED");
    const labelModel = aiModel("OLLAMA_PREDEFINED_AFFIRMATION");
    const rows = batch.flatMap((sample, i) => {
      const embedding = embeddings[i];
      if (!embedding) return [];
      return [
        {
          content_hash: polaritySampleHash(sample.text),
          language_name: sample.languageName,
          label: sample.label,
          label_model: labelModel,
          label_version: sample.labelVersion,
          embedding_model: embeddingModel,
          embedding,
          text_chars: sample.text.trim().length,
        },
      ];
    });
    if (!rows.length) return;
    await db.insert(polarity_samples).values(rows).onConflictDoNothing();
  } catch (error) {
    console.warn("[WARN][POLARITY_SAMPLES] 教師データを保存できなかった", error);
  }
}

/** テスト用。モジュールの状態を初期化する。 */
export function resetPolaritySamplesForTest(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending = [];
  flushing = undefined;
}
