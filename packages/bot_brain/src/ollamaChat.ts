import {
  ollamaTextContextLength,
  aiModel,
  ollamaNativeUrl,
} from "@bsky-affirmative-bot/shared-configs";
import type { AiFeatureKey } from "@bsky-affirmative-bot/shared-configs";
import { reportAiCallAsync } from "./ai/aiCallStats.js";

export type OllamaMessage = { role: string; content: string };

export type OllamaChatOptions = {
  /** 生成の上限トークン。分類なら数トークン、描写なら数百。 */
  maxTokens: number;
  /** 既定は 0（決定論寄り）。描写のように毎回変えたい用途では上げる。 */
  temperature?: number;
  /** 既定 30 秒。ローカルとはいえ長文生成は詰まりうる。 */
  timeoutMs?: number;
};

/** OLLAMA_BASE_URL / OLLAMA_MODEL の両方が揃っているときだけローカル推論を使う。 */
export const isOllamaConfigured = (): boolean =>
  Boolean(process.env.OLLAMA_BASE_URL && process.env.OLLAMA_MODEL);

/**
 * ローカル Ollama（ネイティブ /api/chat）を叩く共通ラッパ。
 *
 * モデルの選択はレジストリに任せる（呼び出し側は feature キーを名乗る）。
 * OLLAMA_MODEL の「有無」だけは Ollama が設定済みかどうかの判定として使い続ける。
 *
 * OpenAI互換の /v1/chat/completions ではなくネイティブを使う理由は2つ。
 * 1. `think: false`。思考するモデルは reasoning を別フィールドへ吐き、その分が生成上限を
 *    食う。分類は maxTokens が数トークンしかないので、切らないと content が空文字のまま
 *    返って機能が丸ごと死ぬ。
 * 2. `num_ctx`。OpenAI互換には指定手段が無く、context 4096 のrunnerが別にロードされて
 *    26Bモデルのリロードが頻発する。詳細は ollamaTextContextLength のコメント。
 */
export async function ollamaChat(
  feature: AiFeatureKey,
  messages: OllamaMessage[],
  options: OllamaChatOptions,
): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!isOllamaConfigured()) throw new Error("Ollama is not configured");
  // ここは generateContentForProvider を通らないので、呼び出し回数を自分で数える。
  try {
    const response = await fetch(`${ollamaNativeUrl(baseUrl!)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: aiModel(feature),
        messages,
        stream: false,
        think: false,
        options: {
          num_ctx: ollamaTextContextLength(),
          temperature: options.temperature ?? 0,
          num_predict: options.maxTokens,
        },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = (await response.json()) as any;
    reportAiCallAsync("ollama", "ok");
    return (data?.message?.content ?? "").trim();
  } catch (error) {
    reportAiCallAsync("ollama", "error");
    throw error;
  }
}
