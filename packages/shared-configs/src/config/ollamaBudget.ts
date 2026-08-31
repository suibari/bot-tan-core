/**
 * ローカル生成のコンテキスト予算。
 *
 * Ollama の `/api/chat` は **num_predict を考慮せずに** プロンプトを num_ctx へ収まるまで
 * 詰める。そのため「プロンプトが num_ctx いっぱい ＝ 生成できるのは残り数トークンだけ」
 * という状態が、エラーにならずに起きる。実測（2026-08-31）では
 * `n_ctx_slot = 16384, task.n_tokens = 16379` となり、返信本文が相手の表示名だけ
 * （5トークン相当）になった。
 *
 * したがって出力枠は**送信側で先に取り置く**しかない。ここはその予算計算だけを持つ。
 */

/** 投稿本文を生成する経路の既定 num_predict。POST_TEXT_LIMIT(2100字) までは要らない。 */
export const OLLAMA_DEFAULT_OUTPUT_TOKENS = 1_024;

/**
 * 投稿にならない長い応答（日次予定表のような構造化JSON）の既定 num_predict。
 * `maxTextLength: null` が「これは投稿本文ではない」という既存の唯一の意思表示なので、
 * 新しい旗を増やさずそれに連動させる。
 */
export const OLLAMA_LONG_OUTPUT_TOKENS = 4_096;

/** どんなに切り詰めてもこれだけは出力に残す。 */
export const OLLAMA_MIN_OUTPUT_TOKENS = 256;

/** 見積もり誤差の逃げ幅。 */
export const OLLAMA_BUDGET_SAFETY_MARGIN = 128;

/**
 * 画像1枚のトークン概算。**文字数には一切現れない**ので別枠で数える。
 * ここを忘れると画像付きリプライだけが同じ事故を起こし続ける。
 */
export const OLLAMA_IMAGE_TOKEN_COST = 320;

/** チャットテンプレートのロールタグ等、メッセージ1件ごとの固定費。 */
const PER_MESSAGE_OVERHEAD_TOKENS = 8;

/** BOS や末尾の生成開始タグなど、リクエスト全体の固定費。 */
const REQUEST_OVERHEAD_TOKENS = 32;

/** 見積もり全体に掛ける安全係数。必ず 1 以上（＝実測より多めに見る）にすること。 */
const SAFETY_FACTOR = 1.15;

/**
 * トークン数の保守的な近似。
 *
 * Ollama にトークン化の公開エンドポイントは無く（`/api/embed` は別モデルの別トークナイザ）、
 * `/api/generate` に `num_predict: 0` を投げる方法は 26B モデルの slot を prefill 1往復ぶん
 * 占有して直列ワーカーのレイテンシを悪化させる。よって文字種別の静的な近似を使い、
 * 実測との比は `[INFO][OLLAMA_BUDGET]` で出して人手で較正する。
 *
 * gemma 系 SentencePiece のおおよその挙動:
 * - ASCII は 3〜4文字で1トークン
 * - 日本語（かな・漢字）は1文字で1トークン前後
 * - 絵文字などの追加面の文字は1つで数トークンに割れる
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let bmpChars = 0;
  let astralChars = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) asciiChars++;
    else if (code <= 0xffff) bmpChars++;
    else astralChars++;
  }
  return Math.ceil(asciiChars / 3.5 + bmpChars * 1.1 + astralChars * 3);
}

export type BudgetMessage = { content: string; images?: string[] };

/** メッセージ1件の見積もり（本文＋画像＋ロールタグ）。安全係数は掛けない。 */
export function estimateMessageTokens(message: BudgetMessage): number {
  return (
    estimateTokens(message.content) +
    (message.images?.length ?? 0) * OLLAMA_IMAGE_TOKEN_COST +
    PER_MESSAGE_OVERHEAD_TOKENS
  );
}

/** リクエスト全体の見積もり。実際に num_ctx と比べるのはこの値。 */
export function estimateMessagesTokens(messages: BudgetMessage[]): number {
  const sum = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    REQUEST_OVERHEAD_TOKENS,
  );
  return Math.ceil(sum * SAFETY_FACTOR);
}

/**
 * プロンプトに使ってよいトークン数。
 *
 * 出力枠と安全マージンを num_ctx から先に引く。ここが 0 以下になる設定は事故なので、
 * 呼び出し側が気付けるよう 0 未満は返さない（0 を返して全部削らせる）。
 */
export function ollamaPromptBudget(options: {
  numCtx: number;
  outputTokens?: number;
}): number {
  const reserved = Math.max(
    options.outputTokens ?? OLLAMA_DEFAULT_OUTPUT_TOKENS,
    OLLAMA_MIN_OUTPUT_TOKENS,
  );
  return Math.max(0, options.numCtx - reserved - OLLAMA_BUDGET_SAFETY_MARGIN);
}
