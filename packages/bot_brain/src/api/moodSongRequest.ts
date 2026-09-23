export const DEFAULT_MOOD_SONG_API_TIMEOUT_MS = 15_000;

export function moodSongApiTimeoutMs(
  raw = process.env.MOOD_SONG_API_TIMEOUT_MS,
  warn: (message: string) => void = console.warn,
) {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MOOD_SONG_API_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    warn(`[WARN][MOOD_SONG_API] invalid_timeout=${raw} default_ms=${DEFAULT_MOOD_SONG_API_TIMEOUT_MS}`);
    return DEFAULT_MOOD_SONG_API_TIMEOUT_MS;
  }
  return parsed;
}

const isTimeoutError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" ||
    ("code" in error && (error as Error & { code?: string }).code === "ERR_CANCELED");
};

/** 投稿本文・検索語・APIキーを出さず、実際の外部通信だけを計測する。 */
export async function withMoodSongApiCall<T>(
  service: "lastfm" | "animethemes" | "youtube",
  operation: string,
  call: (signal: AbortSignal) => Promise<T>,
  deps: {
    now?: () => number;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  try {
    const result = await call(AbortSignal.timeout(deps.timeoutMs ?? moodSongApiTimeoutMs()));
    (deps.info ?? console.log)(
      `[INFO][MOOD_SONG_API] service=${service} operation=${operation} status=ok elapsed_ms=${Math.max(0, Math.round(now() - startedAt))}`,
    );
    return result;
  } catch (error) {
    (deps.warn ?? console.warn)(
      `[WARN][MOOD_SONG_API] service=${service} operation=${operation} status=error timeout=${isTimeoutError(error)} elapsed_ms=${Math.max(0, Math.round(now() - startedAt))}`,
    );
    throw error;
  }
}
