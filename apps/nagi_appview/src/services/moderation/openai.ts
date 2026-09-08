/**
 * OpenAI omni-moderation クライアント。
 *
 * SDK は挟まず fetch で直接叩く。「入力が恒久的に不正（4xx）」と「後で直る障害
 * （429・5xx・ネットワーク）」を HTTP ステータスで厳密に分けたいため。前者は
 * reject-invalid として確定し、後者は投げてワーカーの次周回に任せる。
 */

const ENDPOINT = "https://api.openai.com/v1/moderations";
const MODEL = "omni-moderation-latest";
const TIMEOUT_MS = 20_000;

export type ModerationInput = {
  texts: string[];
  imageUrls: string[];
};

export type ModerationScores = Record<string, number>;

/** 同じ入力を送り直しても直らない失敗。呼び出し側は reject-invalid にする。 */
export class PermanentModerationInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PermanentModerationInputError";
  }
}

/** 後で直る見込みのある失敗。呼び出し側は判定を保留して再試行する。 */
export class TransientModerationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** サーバが指定してきた待ち時間。呼び出し側のバックオフより優先する。 */
    readonly retryAfterMs?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TransientModerationError";
  }
}

/**
 * 「この1件の入力を OpenAI が取りに行けなかった」失敗。
 *
 * サービス障害（429・5xx・タイムアウト）と区別する。ワーカーはこれをバッチ全体の
 * 失敗として扱わず、その1件だけ間隔をあけて再試行する（moderationRetry.ts）。
 * TransientModerationError を継承しているので、retryAfterMs を見る既存の分岐は
 * そのまま効く。
 */
export class TransientModerationInputError extends TransientModerationError {
  constructor(
    message: string,
    status?: number,
    retryAfterMs?: number,
    code?: string,
  ) {
    super(message, status, retryAfterMs, code);
    this.name = "TransientModerationInputError";
  }
}

const isPermanentStatus = (status: number) =>
  status === 400 || status === 413 || status === 422;

/**
 * URL自体は正しくても、OpenAI から AppView/PDS への取得が一時的に
 * 失敗すると HTTP 400 で返る。コンテンツの恒久的な不正とは区別する。
 */
const TRANSIENT_ERROR_CODES = new Set(["image_url_unavailable"]);

/**
 * 実際に返ってくる error.code は確証が無いので、文言でも拾う。
 * 「取りに行けなかった」系だけを対象にし、「画像として不正」は拾わない
 * （invalid_image_format / "Invalid image" はここに一致しないこと）。
 */
const TRANSIENT_MESSAGE_PATTERN =
  /could ?n[o']?t (?:down)?load|could not fetch|failed to (?:down)?load|failed to fetch|error while downloading|timed? ?out|temporarily|unavailable/i;

const parseError = (
  body: string,
): { code?: string; message?: string } => {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
    };
    return {
      code:
        typeof parsed.error?.code === "string" ? parsed.error.code : undefined,
      message:
        typeof parsed.error?.message === "string"
          ? parsed.error.message
          : undefined,
    };
  } catch {
    return {};
  }
};

/**
 * 入力取得の一時失敗か。code 一致か、文言一致で判定する。
 *
 * 誤って恒久エラーをこちらへ倒しても、ワーカー側の再試行上限で最終的に
 * reject-invalid へ落ちるだけなので安全side。逆（一時失敗を恒久扱い）は
 * 無害な投稿を消してしまうので、迷ったらこちらへ倒す。
 */
export const isTransientInputFailure = (
  code: string | undefined,
  message: string | undefined,
): boolean =>
  (!!code && TRANSIENT_ERROR_CODES.has(code)) ||
  (!!message && TRANSIENT_MESSAGE_PATTERN.test(message));

/** Retry-After の上限。壊れた値や極端に長い指定でワーカーを止めないため。 */
const MAX_RETRY_AFTER_MS = 15 * 60_000;

/**
 * Retry-After ヘッダを ms に直す。秒数と HTTP-date の両方が来る。
 * 読めない値・過去の日付・上限超えは undefined を返し、呼び出し側の
 * 通常のバックオフに任せる。
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;

  // 秒数形式。小数を送ってくる実装もあるので Number で受ける。
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date 形式。
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  if (ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export class OpenAIModerator {
  constructor(private readonly apiKey: string) {}

  private async request(
    parts: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >,
  ): Promise<ModerationScores> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, input: parts }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // タイムアウト・DNS・TLS などはすべて後で直りうる。
      throw new TransientModerationError(
        `moderation request failed: ${String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const { code, message } = parseError(body);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      // 文言での判定は 4xx のときだけ。429・5xx は本文に "unavailable" 等が
      // 入っていてもサービス障害であり、従来どおり全体バックオフを動かす。
      if (isPermanentStatus(response.status)) {
        if (isTransientInputFailure(code, message))
          throw new TransientModerationInputError(
            `moderation could not fetch an input (${code ?? "no code"}): ${body.slice(0, 500)}`,
            response.status,
            retryAfterMs,
            code,
          );
        throw new PermanentModerationInputError(
          response.status,
          `moderation rejected the input with HTTP ${response.status}: ${body.slice(0, 500)}`,
          code,
        );
      }
      throw new TransientModerationError(
        `moderation failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
        response.status,
        retryAfterMs,
        code,
      );
    }

    const json = (await response.json().catch(() => null)) as any;
    const scores = json?.results?.[0]?.category_scores;
    if (!scores || typeof scores !== "object")
      throw new TransientModerationError(
        "moderation returned an unexpected response shape",
      );

    const out: ModerationScores = {};
    for (const [category, value] of Object.entries(scores)) {
      if (typeof value === "number" && Number.isFinite(value))
        out[category] = value;
    }
    return out;
  }

  /**
   * テキストと画像URLを判定する。Moderation API は1リクエストにつき画像1枚まで
   * なので、複数画像は1枚ずつ順に判定し、カテゴリごとの最大スコアを採用する。
   * 生レスポンスは保持しない（PDS が真実源のため）。
   */
  async evaluate(input: ModerationInput): Promise<ModerationScores> {
    const text = input.texts
      .map((value) => value?.trim())
      .filter((value): value is string => !!value)
      .join("\n");
    const textPart = text ? ({ type: "text", text } as const) : undefined;
    const imageUrls = input.imageUrls.filter(Boolean);

    // 判定すべき中身が無い（本文空・画像なし）ならAPIを呼ばずに素通しする。
    if (!textPart && imageUrls.length === 0) return {};
    if (imageUrls.length === 0) return this.request([textPart!]);

    const merged: ModerationScores = {};
    for (const url of imageUrls) {
      const scores = await this.request([
        ...(textPart ? [textPart] : []),
        { type: "image_url", image_url: { url } },
      ]);
      for (const [category, score] of Object.entries(scores)) {
        merged[category] = Math.max(merged[category] ?? 0, score);
      }
    }
    return merged;
  }
}
