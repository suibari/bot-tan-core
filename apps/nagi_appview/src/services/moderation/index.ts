import { config } from "../../config.js";
import {
  OpenAIModerator,
  PermanentModerationInputError,
  type ModerationInput,
} from "./openai.js";
import {
  DEFAULT_THRESHOLDS,
  evaluateScores,
  MODERATION_RULE_VERSION,
  type ModerationEvaluation,
} from "./rules.js";

export * from "./rules.js";
export * from "./subject.js";
export {
  PermanentModerationInputError,
  TransientModerationError,
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
 * 判定入力を評価する。
 *
 * 入力が恒久的に不正（壊れた blob など）なら reject-invalid を返し、規約違反とは
 * 分けて扱う。429・5xx・タイムアウトは TransientModerationError のまま投げ直し、
 * 呼び出し側（ワーカー）が判定を保留して次周回で再試行する。
 */
export async function evaluateModerationInput(
  input: ModerationInput,
): Promise<ModerationEvaluation> {
  try {
    const scores = await client().evaluate(input);
    return evaluateScores(scores, DEFAULT_THRESHOLDS);
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

export { MODERATION_RULE_VERSION };
