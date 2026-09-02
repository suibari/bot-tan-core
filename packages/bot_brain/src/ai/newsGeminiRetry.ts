import retry from "async-retry";

const TOTAL_ATTEMPTS = 3;
const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);
const RETRYABLE_ERROR_NAMES = new Set(["AbortError", "FetchError", "TimeoutError"]);

export interface NewsGeminiRetryContext {
  stage: "gate" | "comment";
  articleId?: string;
  mode?: "url_context" | "search" | "plain";
}

interface NewsGeminiRetryOptions {
  minTimeout?: number;
  randomize?: boolean;
  logger?: Pick<Console, "warn">;
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

export function newsGeminiErrorStatus(error: unknown): number | undefined {
  const status = errorRecord(error)?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);
  return undefined;
}

function hasRetryableNetworkCode(error: unknown): boolean {
  const record = errorRecord(error);
  if (!record) return false;
  if (typeof record.code === "string" && RETRYABLE_NETWORK_CODES.has(record.code)) return true;
  return record.cause !== undefined && hasRetryableNetworkCode(record.cause);
}

export function isRetryableNewsGeminiError(error: unknown): boolean {
  const status = newsGeminiErrorStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }
  if (hasRetryableNetworkCode(error)) return true;
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (["fetch failed", "failed to fetch", "network error", "networkerror", "load failed"]
      .some((fragment) => message.includes(fragment))) return true;
  }
  const name = errorRecord(error)?.name;
  return typeof name === "string" && RETRYABLE_ERROR_NAMES.has(name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withNewsGeminiRetry<T>(
  context: NewsGeminiRetryContext,
  operation: () => Promise<T>,
  options: NewsGeminiRetryOptions = {},
): Promise<T> {
  const logger = options.logger ?? console;
  return retry(
    async (bail) => {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableNewsGeminiError(error)) return bail(error) as never;
        throw error;
      }
    },
    {
      retries: TOTAL_ATTEMPTS - 1,
      factor: 2,
      minTimeout: options.minTimeout ?? 1_000,
      randomize: options.randomize ?? true,
      onRetry: (error, failedAttempt) => {
        const status = newsGeminiErrorStatus(error);
        const details = [
          `stage=${context.stage}`,
          context.mode ? `mode=${context.mode}` : undefined,
          context.articleId ? `article=${context.articleId}` : undefined,
          `status=${status ?? "network"}`,
          `failedAttempt=${failedAttempt}/${TOTAL_ATTEMPTS}`,
        ].filter(Boolean).join(" ");
        logger.warn(`[WARN][NEWS_FEED] Gemini retry ${details}: ${errorMessage(error)}`);
      },
    },
  );
}
