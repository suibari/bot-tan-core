import {
  classifyAiError,
  formatAiError,
  resolveAiRoute,
  type AiErrorCategory,
  type AiRouteName,
} from "@bsky-affirmative-bot/shared-configs";

export type NagiReplyErrorCategory = AiErrorCategory;
/** ラダーの各段が指すルート。実体は shared-configs の aiRoutes.ts が持つ。 */
export type NagiAiRoute = AiRouteName;

export type NagiReplyErrorClassification = {
  category: NagiReplyErrorCategory;
  status?: number;
  code?: string;
};

export type NagiAiRouteDetails = {
  route: NagiAiRoute;
  model: string;
  /** undefined = serviceTier を送らない（"-auto" 系ルートを割り当てた場合） */
  serviceTier?: "flex" | "standard";
};

const DAY_MS = 24 * 60 * 60_000;
const UNKNOWN_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

/** cause 連鎖に指定メッセージを含むエラーがあるか。 */
function chainIncludes(error: unknown, needle: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current instanceof Error && current.message.includes(needle)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/**
 * 汎用の分類（shared-configs の classifyAiError）に、リプライ固有のルールを1つ足す。
 * 直接添付画像の取得失敗は内側のHTTP状態にかかわらずジョブ全体を一時障害として扱う。
 * PDS/CDNの伝播待ちを24時間の永続キューで吸収し、画像を黙って省略しない。
 */
export function classifyNagiReplyError(
  error: unknown,
): NagiReplyErrorClassification {
  const classified = classifyAiError(error);
  if (
    classified.category !== "transient" &&
    chainIncludes(error, "Failed to fetch directly attached image")
  ) {
    return { ...classified, category: "transient" };
  }
  // コンテキスト溢れと劣化生成は一時障害として扱う。次の試行では履歴がもう少し
  // 削れていたり grounding が付かなかったりで通ることがあるため。永続扱いにすると
  // 1回のブレで返信が永久に消える。
  if (classified.category !== "transient" && isDegenerateGenerationError(error)) {
    return { ...classified, category: "transient" };
  }
  return classified;
}

/**
 * 「モデルの出力そのものが使い物にならなかった」失敗か。
 *
 * ネットワークやクォータの失敗と違い、これは再試行しても同じ入力なら同じ結果になりうる。
 * ラダーを使い切ったときに定型文へ落とす判断に使う（無言で消えるより定型文の方がよい）。
 */
export function isDegenerateGenerationError(error: unknown): boolean {
  return (
    isNamedError(error, "OllamaContextOverflowError") ||
    isNamedError(error, "DegenerateReplyError")
  );
}

/** cause 連鎖に指定名のエラーがあるか。instanceof を使わないのは循環importを避けるため。 */
function isNamedError(error: unknown, name: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current instanceof Error && current.name === name) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export const formatNagiReplyError = formatAiError;

/**
 * 何回目の試行にどのルートを充てるか。段の刻み方（1-2 / 3-4 / 5以降）はここが決めるが、
 * 各段が実際にどのモデル・tier になるかは shared-configs の AI_FEATURES と
 * AI_ROUTE_NAGI_REPLY_ATTEMPT_{EARLY,MID,LATE} が決める。
 */
export function nagiAiRouteForAttempt(attempt: number): NagiAiRouteDetails {
  const feature =
    attempt <= 2
      ? "NAGI_REPLY_ATTEMPT_EARLY"
      : attempt <= 4
        ? "NAGI_REPLY_ATTEMPT_MID"
        : "NAGI_REPLY_ATTEMPT_LATE";
  const resolved = resolveAiRoute(feature);
  // ResolvedAiRoute をそのまま返さない。feature/provider/source が混ざると
  // 呼び出し側やログ/テストが余計なフィールドを見てしまうので3項目に射影する。
  return {
    route: resolved.route,
    model: resolved.model,
    ...(resolved.serviceTier ? { serviceTier: resolved.serviceTier } : {}),
  };
}

export function nextNagiReplyAttemptAt(input: {
  attempt: number;
  category: NagiReplyErrorCategory;
  createdAt: Date;
  now: Date;
  random?: () => number;
}): Date | undefined {
  if (input.category === "permanent") return undefined;
  if (input.category === "unknown" && input.attempt >= UNKNOWN_MAX_ATTEMPTS) {
    return undefined;
  }

  const deadlineMs = input.createdAt.getTime() + DAY_MS;
  if (input.now.getTime() >= deadlineMs) return undefined;

  const baseDelay =
    RETRY_DELAYS_MS[Math.min(input.attempt - 1, RETRY_DELAYS_MS.length - 1)];
  const random = input.random ?? Math.random;
  const jitteredDelay = Math.round(baseDelay * (0.8 + random() * 0.4));
  return new Date(Math.min(input.now.getTime() + jitteredDelay, deadlineMs));
}
