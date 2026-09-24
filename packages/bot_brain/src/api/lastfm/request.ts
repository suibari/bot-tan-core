import { setTimeout as sleep } from "node:timers/promises";
import { withMoodSongApiCall } from "../moodSongRequest.js";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
// https://www.last.fm/api/tos §4.4 は数値上限を公開していない。
// 同一IPの別botにも余裕を残すため、各プロセスで最大1件/秒に抑える。
// 全メソッド共通の運用値であり、Last.fmが保証する上限ではない。
const REQUEST_INTERVAL_MS = 1_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

type ApiBody = { error?: number; message?: string };

export class LastFmRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("Last.fm rate limited; requests temporarily suspended");
    this.name = "LastFmRateLimitError";
  }
}

/** プロセス内で全APIキー・全メソッドの送信を直列化する（制限はIP単位）。 */
export function createLastFmRequester(deps: {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
} = {}) {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  let tail: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;
  let blockedUntil = 0;
  const inFlight = new Map<string, Promise<ApiBody>>();

  return function request<T extends ApiBody>(params: URLSearchParams, fetchImpl: typeof fetch): Promise<T> {
    const key = params.toString();
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const result = tail.then(async () => {
      if (now() < blockedUntil) throw new LastFmRateLimitError(blockedUntil);
      const delay = nextRequestAt - now();
      if (delay > 0) await wait(delay);
      if (now() < blockedUntil) throw new LastFmRateLimitError(blockedUntil);
      nextRequestAt = now() + REQUEST_INTERVAL_MS;
      // キュー待ちは外部通信のタイムアウトに含めない。
      return withMoodSongApiCall("lastfm", params.get("method") ?? "unknown", async (signal) => {
        const response = await fetchImpl(`${LASTFM_API_URL}?${params}`, {
          headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" }, signal,
        });
        const suspend = () => {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
          const retryAt = Number.isFinite(seconds)
            ? now() + Math.max(0, seconds) * 1_000
            : Date.parse(retryAfter ?? "");
          blockedUntil = Math.max(now() + RATE_LIMIT_COOLDOWN_MS, Number.isFinite(retryAt) ? retryAt : 0);
          return new LastFmRateLimitError(blockedUntil);
        };
        if (response.status === 429) {
          const error = suspend();
          await response.body?.cancel();
          throw error;
        }
        if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
        const body = await response.json() as T;
        if (body.error === 29) throw suspend();
        if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
        return body;
      });
    });
    inFlight.set(key, result);
    tail = result.then(() => undefined, () => undefined);
    void tail.then(() => inFlight.delete(key));
    return result;
  };
}

const productionRequester = createLastFmRequester();
const injectedRequesters = new WeakMap<typeof fetch, ReturnType<typeof createLastFmRequester>>();

export function requestLastFm<T extends ApiBody>(params: URLSearchParams, fetchImpl?: typeof fetch): Promise<T> {
  if (!fetchImpl) return productionRequester<T>(params, fetch);
  // テスト用transport同士は状態を共有しない。同じtransportには本番と同じ制御を適用する。
  let request = injectedRequesters.get(fetchImpl);
  if (!request) {
    request = createLastFmRequester();
    injectedRequesters.set(fetchImpl, request);
  }
  return request<T>(params, fetchImpl);
}
