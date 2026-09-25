import {
  ollamaPromptBudget,
  ollamaTextContextLength,
  POST_MOOD_VERSION,
  resolveAiRoute,
} from "@bsky-affirmative-bot/shared-configs";
import { ollamaChat, type OllamaMessage } from "../ollamaChat.js";
import { fitOllamaMessages } from "./generationClient.js";

/**
 * 日記の感情グラフ用に、投稿1件の「書き手の気分」を -5〜+5 で採点する。
 *
 * 2026-09-25 に suibari.com の全投稿（426件）で PoC をとって決めたプロンプト。
 * 初版は目安を奇数の段にしか書かず、告知や開発メモまで熱意で +3 に寄っていた（+3 が 123件）。
 * 全段に目安を置き、告知・説明を 0〜+1、ネタを ±2 以内に抑えたこの版で +3 は 31件になり、
 * +2 と -2 が使われるようになった。深い落ち込み（-5）と強い喜びの拾い方は変わらない。
 *
 * 開発報告やイラスト投稿が 0 に寄るのは仕様（本人確認済み）。画像は渡していない。
 */

// 版は AppView も参照するので shared-configs に置いてある。ワーカーはここから引く。
export { POST_MOOD_VERSION };

/** 長文ブログをそのまま渡さない。気分は冒頭で十分に読める。 */
const MAX_TEXT_CHARS = 2000;

/** 出力は {"valence":-5,"expressive":false} 程度。プロンプト予算の出力枠にも使う。 */
const MAX_OUTPUT_TOKENS = 40;

const SYSTEM_PROMPT = `あなたはSNS投稿の書き手の「気分」を読み取る採点者です。
投稿1件を読み、書いた本人がそのとき明るい気分か落ち込んだ気分かを -5〜+5 の整数で採点してください。
採点するのは「書き手本人の気分」です。話題の良し悪しや、書き手の熱意・意欲の強さではありません。

段階（すべての整数を使ってよい）:
+5 最高に嬉しい。念願が叶った、感激して叫んでいる
+4 とても嬉しい・楽しかった。「うれしい！」「最高」など強い喜びの言葉がある
+3 はっきり楽しい・満足している。喜びや楽しさを表す言葉や出来事がある
+2 楽しそう・機嫌がいい。軽い喜び、期待、好きなものの話
+1 わずかに前向き。穏やかな好意や興味
 0 気分が読み取れない。告知、機能説明、技術メモ、ニュースや事実の共有、質問、テスト投稿
-1 わずかに後ろ向き。軽い不満、面倒くさい、ちょっとした残念
-2 やや沈んでいる。疲れ、心配、がっかり
-3 はっきりつらい。体調不良の苦しさ、強い不安、悲しさ、イライラ
-4 とてもつらい。自己否定、吐きそう、限界に近い
-5 深く落ち込んでいる。絶望、消えたい、辞めたいほど追い詰められている

注意:
- +3以上・-3以下は、気分を表す言葉（うれしい、楽しい、しんどい、つらい等）や、気分に直結する出来事がはっきり書かれているときだけ付ける。
- 告知・募集・仕様説明・開発方針の説明は、前向きな口調でも 0〜+1。
- ネタ、ミーム、冗談の叫び（「〇〇欲しい！！」「😱」など）は、実際の気分ではなく遊びなので ±2 以内に抑える。
- 「草」「ｗ」を伴う愚痴は、自嘲の明るさとして少しプラスに寄せてよい。
- 喜びとつらさが混ざる場合は、投稿全体の主な気分で決める。
- expressive は、書き手の気分が読み取れるとき true、0 の類型（告知・説明・事実共有など）なら false。`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    valence: { type: "integer", minimum: -5, maximum: 5 },
    expressive: { type: "boolean" },
  },
  required: ["valence", "expressive"],
};

export type PostMood = { valence: number; expressive: boolean };

/** モデル出力の検証。範囲外や型違いは採点不能（null）として扱う。 */
export function parsePostMood(raw: string): PostMood | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { valence, expressive } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof valence !== "number" ||
    !Number.isInteger(valence) ||
    valence < -5 ||
    valence > 5 ||
    typeof expressive !== "boolean"
  )
    return null;
  // 0 なのに expressive=true は「気分は読めたが中立」という矛盾なので中立に揃える。
  return { valence, expressive: valence === 0 ? false : expressive };
}

/**
 * 採点がローカル Ollama へ向いているか。
 *
 * AI_ROUTE_NAGI_POST_MOOD は env で Gemini ルートにも上書きできてしまうが、ollamaChat は
 * 解決したモデル名をそのままローカル Ollama へ送るので、全件が失敗するうえ
 * 「本人しか見ない値を外へ出さない」前提も崩れる。ローカル以外なら採点しない。
 */
export function isPostMoodRouteLocal(): boolean {
  return resolveAiRoute("NAGI_POST_MOOD").provider === "ollama";
}

/**
 * 送るメッセージを組み立てて、num_ctx から出力枠を引いた予算へ収める。
 * 投稿本文の文字数上限だけでは、num_ctx が小さい環境やトークン化が膨らむ本文で
 * 出力枠が潰れ、壊れた JSON が採点不能として保存されてしまう。
 */
export function buildPostMoodMessages(
  body: string,
  numCtx = ollamaTextContextLength(),
): OllamaMessage[] {
  const messages: Parameters<typeof fitOllamaMessages>[0] = [
    { role: "system", content: SYSTEM_PROMPT },
    // AGENTS.md「プロンプトの並び順」: 投稿はいちばん後ろ。
    { role: "user", content: `<post>\n${body}\n</post>` },
  ];
  return fitOllamaMessages(messages, {
    budget: ollamaPromptBudget({ numCtx, outputTokens: MAX_OUTPUT_TOKENS }),
  }).messages;
}

/**
 * 本文が空なら採点せず null。モデル出力が壊れていても null（呼び出し側は採点不能として保存し、
 * 同じ投稿で Ollama を叩き続けない）。Ollama への接続失敗と、ルートがローカルでないときは
 * 例外のまま投げる（どちらも保存させない）。
 */
export async function scorePostMood(text: string): Promise<PostMood | null> {
  const body = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!body) return null;
  if (!isPostMoodRouteLocal())
    throw new Error("NAGI_POST_MOOD must be routed to local Ollama");
  const raw = await ollamaChat("NAGI_POST_MOOD", buildPostMoodMessages(body), {
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    format: RESPONSE_SCHEMA,
    timeoutMs: 60_000,
  });
  return parsePostMood(raw);
}
