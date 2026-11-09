import { config } from "../../config.js";
import {
  OpenAIModerator,
  PermanentModerationInputError,
  type ModerationInput,
} from "./openai.js";
import {
  evaluateSeparatedScores,
  GENERATION_OBSERVE_ONLY_CATEGORIES,
  MODERATION_RULE_VERSION,
  TEXT_OBSERVE_ONLY_CATEGORIES,
  type ModerationEvaluation,
} from "./rules.js";
import { findExplicitTerms } from "./explicitTerms.js";

export * from "./rules.js";
export * from "./subject.js";
export * from "./explicitTerms.js";
export {
  PermanentModerationInputError,
  TransientModerationError,
  TransientModerationInputError,
  isTransientInputFailure,
  type ModerationInput,
} from "./openai.js";

let moderator: OpenAIModerator | undefined;
/** OPENAI_API_KEY が無ければ判定機能ごと無効。取り込みも投稿も止まらない。 */
export const moderationEnabled = (): boolean => !!config.moderation;

function client(): OpenAIModerator {
  if (!config.moderation)
    throw new Error("moderation is not configured (OPENAI_API_KEY is unset)");
  moderator ??= new OpenAIModerator(config.moderation.apiKey);
  return moderator;
}

/**
 * 判定の用途。
 *
 * - ingest: ユーザーの投稿・プロフィールなど。本文の sexual/minors は記録だけ。
 * - news: 外部記事の見出し。真面目な文脈で性的な語が出るので語句リストは当てない。
 * - generation: 生成の入力（絵文字のプロンプト）。ここから画像を作るので sexual/minors も止める。
 */
export type ModerationPurpose = "ingest" | "news" | "generation";

/**
 * 判定入力を評価する。
 *
 * 入力が恒久的に不正（壊れた blob など）なら reject-invalid を返し、規約違反とは
 * 分けて扱う。429・5xx・タイムアウトは TransientModerationError のまま投げ直し、
 * 呼び出し側（ワーカー）が判定を保留して次周回で再試行する。
 */
export async function evaluateModerationInput(
  input: ModerationInput,
  purpose: ModerationPurpose = "ingest",
): Promise<ModerationEvaluation> {
  try {
    const scores = await client().evaluate(input);
    return evaluateSeparatedScores(scores, {
      textObserveOnly:
        purpose === "generation"
          ? GENERATION_OBSERVE_ONLY_CATEGORIES
          : TEXT_OBSERVE_ONLY_CATEGORIES,
      explicitTerms: purpose === "news" ? [] : findExplicitTerms(input.texts),
    });
  } catch (error) {
    if (error instanceof PermanentModerationInputError) {
      return {
        decision: "reject-invalid",
        labels: [],
        reasons: [`[INVALID] ${error.message}`],
        maxScore: 0,
        highestCategory: "invalid-input",
      };
    }
    throw error;
  }
}

/**
 * 入力取得の再試行予算を使い切ったときの判定結果。
 *
 * 恒久的な入力不正と同じ reject-invalid だが、運用者が「取りに行けなかった」と
 * 「そもそも壊れていた」を Discord で見分けられるよう理由を分けている。
 */
export function exhaustedInputEvaluation(
  error: Error,
  failures: number,
): ModerationEvaluation {
  return {
    decision: "reject-invalid",
    labels: [],
    reasons: [
      `[INVALID] 入力を取得できず ${failures} 回再試行しましたが復旧しませんでした: ${error.message}`,
    ],
    maxScore: 0,
    highestCategory: "invalid-input",
  };
}

export { MODERATION_RULE_VERSION };
