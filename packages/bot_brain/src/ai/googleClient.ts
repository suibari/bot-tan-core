import { GoogleGenAI } from "@google/genai";

/** Grounding・画像生成と、AI_TEXT_PROVIDER=gemini の切り戻し時にだけ使う。 */
let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  return client;
}

// Ollamaだけを使うプロセスではGoogleクライアントを初期化しない。既存の
// `gemini.models` 呼び出し・テストmockとの互換性はProxyで維持する。
export const gemini = new Proxy({} as GoogleGenAI, {
  get(_target, property) {
    return Reflect.get(getClient() as object, property);
  },
});
