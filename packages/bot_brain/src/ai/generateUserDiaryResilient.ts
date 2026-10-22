import { randomUUID } from "node:crypto";
import { DiaryValidationError } from "./diaryValidation.js";
import { classifyAiError, runWithAiLadder, type AiLadderStep, type UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  generateUserDiaryDraft,
  resolveUserDiaryResponseFormat,
  type DiaryDraft,
  type GenerateUserDiaryOptions,
  type DiaryResult,
  type UserDiaryDayContext,
  type UserDiaryResponseFormat,
} from "./generateUserDiary.js";
import type { UserDiaryMediaReference } from "@bsky-affirmative-bot/shared-configs";
import type { GeminiUsage } from "./util.js";

/**
 * 日記の再試行ラダー。段の刻み方はここ、各段のモデル/tier は shared-configs の
 * AI_FEATURES と AI_ROUTE_COMMON_DIARY_ATTEMPT_* が決める。
 */
export const DIARY_LADDER: readonly AiLadderStep[] = [
  { untilAttempt: 2, feature: "COMMON_DIARY_ATTEMPT_EARLY" },
  { untilAttempt: 4, feature: "COMMON_DIARY_ATTEMPT_MID" },
  { untilAttempt: 6, feature: "COMMON_DIARY_ATTEMPT_LATE" },
];

export const DIARY_MAX_ATTEMPTS = 6;

/**
 * 失敗後の待ち時間。Flex tier の 503 は分単位で続くので、秒オーダーで諦めない。
 * 全部使うと 30s+2m+10m+30m+60m ≒ 1時間43分。
 */
const DIARY_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

/** 開始から3時間で打ち切る。翌日の22時スケジュールと重ならない範囲に収める。 */
const DIARY_DEADLINE_MS = 3 * 60 * 60_000;

/**
 * 日記本文を設定されたルートのラダーに沿って再試行する。
 * Ollamaでは各段が同じモデルを指すこともあり、必ずモデルが変わるわけではない。
 *
 * generateUserDiary をそのまま呼ぶと、
 *   - Flex tier の 503（容量待ち）
 *   - 空レスポンス / JSON パース失敗 / 必須項目の検証失敗
 * のいずれでもその日の日記が丸ごと欠測する。1日1回しか機会が無いので、
 * transient は上限まで、それ以外も unknown 扱いで数回は再生成する。
 */
export async function generateUserDiaryResilient(
  userinfo: UserInfoGemini,
  options: {
    dayContext?: UserDiaryDayContext;
    mediaReference?: UserDiaryMediaReference;
    /** ログ用の識別子。例: "[NAGI][did:plc:xxx][DIARY]" */
    label: string;
    surface?: "bsky" | "nagi" | "evaluation";
    responseFormat?: UserDiaryResponseFormat;
    /** テスト注入用。 */
    generateDraft?: (userinfo: UserInfoGemini, options: GenerateUserDiaryOptions) => Promise<DiaryDraft>;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DiaryResult> {
  const generateDraft = options.generateDraft ?? generateUserDiaryDraft;
  const runId = randomUUID();
  const responseFormat = resolveUserDiaryResponseFormat(options.responseFormat);
  const startedAt = Date.now();
  const identity = `run_id=${runId} surface=${options.surface ?? "unknown"} subject=${userinfo.follower.did} date=${options.dayContext?.date ?? "unknown"} format=${responseFormat}`;
  let attempts = 0;
  let calls = 0;
  let responses = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let completed = false;
  let draft: DiaryDraft;
  try {
    draft = await runWithAiLadder({
      ladder: DIARY_LADDER,
      delaysMs: DIARY_RETRY_DELAYS_MS,
      deadlineMs: DIARY_DEADLINE_MS,
      maxAttempts: DIARY_MAX_ATTEMPTS,
      label: options.label,
      operation: "generateUserDiary",
      run: async (aiRoute, attempt) => {
        attempts = attempt;
        let attemptCalls = 0;
        let attemptInput = 0;
        let attemptOutput = 0;
        let attemptThinking = 0;
        let attemptTotal = 0;
        let attemptLatency = 0;
        let lastUsage: GeminiUsage | undefined;
        const logAttempt = (valid: boolean, reason: string) => {
          console.info(
            `${options.label} diary_ai operation=body ${identity} attempt=${attempt} calls=${attemptCalls} model=${lastUsage?.model ?? aiRoute.model} tier=${lastUsage?.serviceTier ?? "auto"} latency_ms=${attemptLatency} input_tokens=${attemptInput} output_tokens=${attemptOutput} thinking_tokens=${attemptThinking} total_tokens=${attemptTotal} valid=${valid} reason=${reason}`,
          );
        };
        try {
          const result = await generateDraft(userinfo, {
            ...(options.dayContext ? { dayContext: options.dayContext } : {}),
            ...(options.mediaReference ? { mediaReference: options.mediaReference } : {}),
            aiRoute,
            responseFormat,
            diagnosticContext: { runId, attempt, surface: options.surface ?? "unknown" },
            onRequest: () => {
              calls++;
              attemptCalls++;
              console.info(`${options.label} diary_ai_request ${identity} attempt=${attempt} call=${calls} attempt_call=${attemptCalls}`);
            },
            onUsage: (usage) => {
              lastUsage = usage;
              responses++;
              inputTokens += usage.promptTokens;
              outputTokens += usage.outputTokens;
              totalTokens += usage.totalTokens;
              attemptInput += usage.promptTokens;
              attemptOutput += usage.outputTokens;
              attemptThinking += usage.thinkingTokens;
              attemptTotal += usage.totalTokens;
              attemptLatency += usage.latencyMs;
              // 応答を受け取るたびに記録。検証前なのでvalidは付けない。
              console.info(
                `${options.label} diary_ai_call ${identity} attempt=${attempt} call=${calls} attempt_call=${attemptCalls} model=${usage.model} tier=${usage.serviceTier ?? "auto"} latency_ms=${usage.latencyMs} input_tokens=${usage.promptTokens} output_tokens=${usage.outputTokens} thinking_tokens=${usage.thinkingTokens} total_tokens=${usage.totalTokens} truncated=${usage.truncated ?? "unknown"} output_limit=${usage.outputLimit ?? "unknown"} ollama_total_ms=${usage.ollamaTotalDurationMs ?? "unknown"}`,
              );
            },
          });
          if (!result || result.diary === "") {
            throw new DiaryValidationError("empty", "generateUserDiary returned empty");
          }
          logAttempt(true, "ok");
          return result;
        } catch (error) {
          const reason = error instanceof DiaryValidationError
            ? error.reason
            : classifyAiError(error).category;
          logAttempt(false, reason);
          if (error instanceof DiaryValidationError && Object.keys(error.diagnostics).length) {
            console.info(`${options.label} diary_validation ${identity} attempt=${attempt} reason=${reason} ${Object.entries(error.diagnostics).map(([key, value]) => `${key}=${value}`).join(" ")}`);
          }
          throw error;
        }
      },
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    completed = true;
  } finally {
    console.info(`${options.label} diary_run ${identity} attempts=${attempts} calls=${calls} responses=${responses} input_tokens=${inputTokens} output_tokens=${outputTokens} total_tokens=${totalTokens} elapsed_ms=${Date.now() - startedAt} completed=${completed}`);
  }

  return {
    diary: draft.diary,
    title_ja: draft.title_ja,
    title_en: draft.title_en,
  };
}
