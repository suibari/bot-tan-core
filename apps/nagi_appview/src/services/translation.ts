import { setTimeout as delay } from "node:timers/promises";
import {
  MemoryService,
  db,
  nagiPosts,
  nagiTranslations,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  NAGI,
  NAGI_LANGUAGES,
  STANDARD_SITE_DOCUMENT,
  TRILINES,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  BOT_VOICE_BRIEF_EN,
  OLLAMA_BUDGET_SAFETY_MARGIN,
  OLLAMA_MIN_OUTPUT_TOKENS,
  estimateTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
  ollamaNativeUrl,
} from "@bsky-affirmative-bot/shared-configs";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import { kossoriVisibility } from "../queries/timeline.js";
import { hasContentWarning } from "../util/contentWarning.js";

export const TRANSLATION_CACHE_VERSION = 4;
export const MAX_TRANSLATION_BATCH_SIZE = 50;
export const TRANSLATION_MAX_CHUNKS = 16;
const TRANSLATION_DEADLINE_MS = 180_000;

type Language = (typeof NAGI_LANGUAGES)[number];
/**
 * 訳す元の文。Nagi 投稿の本文と、ゼンカツ提出の「作者の意図」（note）の2種類がある。
 * どちらも AT URI で引き、訳文は同じ translations テーブルに URI で載せる。
 */
type TranslationSource = {
  uri: string;
  did: string;
  text: string;
  langs: unknown;
};
export type TranslationFailureCode =
  | "not_found"
  | "not_cached"
  | "empty_post"
  | "content_warning"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_output";
export type TranslationBatchResult = {
  translations: Array<{ uri: string; text: string }>;
  failures: Array<{ uri: string; code: TranslationFailureCode }>;
};

const languageByCode = new Map(
  NAGI_LANGUAGES.map((language) => [language.code, language]),
);
const englishLanguage = languageByCode.get("en")!;

const sourceLanguageFrom = (langs: unknown): Language | undefined => {
  const sourceCode = Array.isArray(langs) ? String(langs[0] ?? "") : "";
  return languageByCode.get(
    sourceCode
      .split("-")[0]
      ?.toLowerCase() as (typeof NAGI_LANGUAGES)[number]["code"],
  );
};

/** 対応言語として明示された、英語以外の投稿だけを事前英訳する。 */
export const shouldPrewarmEnglish = (langs: unknown) => {
  const source = sourceLanguageFrom(langs);
  return Boolean(source && source.code !== "en");
};

export const shouldStartEnglishPrewarm = (
  existing: boolean,
  reconcile: boolean,
  langs: unknown,
) => !existing && !reconcile && shouldPrewarmEnglish(langs);

/**
 * 翻訳してよい投稿の条件。翻訳 API は未サインインでも使える（viewer が居ない）ので、
 * こっそりスレッドと削除済みの投稿は誰が叩いても訳さない。キャッシュ済みの訳も返さない。
 *
 * 他人の PDS に残ったリアクションレコードには、こっそり投稿の URI が載っていることがある。
 * URI を知っていても本文を引けないことは、ここが担保する。
 */
export const translatablePosts = (uris: string[]) =>
  and(
    inArray(nagiPosts.uri, uris),
    isNull(nagiPosts.deletedAt),
    kossoriVisibility(undefined),
  );

function targetLanguage(value: unknown): Language {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_request", "Unsupported target language");
  }
  try {
    const code = Intl.getCanonicalLocales(value)[0]
      ?.split("-")[0]
      ?.toLowerCase();
    const language = code
      ? languageByCode.get(code as (typeof NAGI_LANGUAGES)[number]["code"])
      : undefined;
    if (language) return language;
  } catch {
    // Invalid language tags are reported as an invalid request below.
  }
  throw new ApiError(400, "invalid_request", "Unsupported target language");
}

/**
 * 訳してよい作者の意図の条件。表示（visibleZenkatsuNote）と同じく、判定待ちと
 * 却下（note を NULL に戻している）は返さない。判定し直しの間はキャッシュ済みの訳も出さない。
 */
export const translatableZenkatsuNotes = (uris: string[]) =>
  and(
    inArray(nagiZenkatsuSubmissions.uri, uris),
    isNull(nagiZenkatsuSubmissions.deletedAt),
    isNotNull(nagiZenkatsuSubmissions.note),
    isNotNull(nagiZenkatsuSubmissions.noteModerationVersion),
  );

/** ゼンカツ提出の AT URI か。訳すのは本文ではなく作者の意図。 */
export function isZenkatsuUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^at://did:(?:plc|web):[^/]+/${NAGI.zenkatsu}/[^/]+$`).test(
      value,
    )
  );
}

/**
 * Nagi 投稿（standard.site のブログと TriLinesAt の3行日記を含む）の AT URI か。
 * 3行日記は取り込み時に行を改行でつないで nagi_posts に載せているので、投稿と同じく訳せる。
 */
export function isNagiPostUri(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(
      `^at://did:(?:plc|web):[^/]+/(?:${NAGI.post}|${STANDARD_SITE_DOCUMENT}|${TRILINES.diary})/[^/]+$`,
    ).test(value)
  );
}

function postUri(value: unknown): string {
  if (!isNagiPostUri(value) && !isZenkatsuUri(value)) {
    throw new ApiError(400, "invalid_request", "Invalid post URI");
  }
  return value;
}

function postUris(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_TRANSLATION_BATCH_SIZE
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `uris must contain between 1 and ${MAX_TRANSLATION_BATCH_SIZE} posts`,
    );
  }
  return [...new Set(value.map(postUri))];
}

/** 内容や長さはモデルへ委ね、保存不能な空応答だけを落とす。 */
export function hasTranslationText(translated: string) {
  return Boolean(translated.trim());
}

export function translationPrompt(
  source: Language | undefined,
  target: Language,
  text: string,
) {
  const sourceName = source?.name ?? "the detected source language";
  const sourceCode = source?.code ?? "auto";
  return `You are a professional ${sourceName} (${sourceCode}) to ${target.name} (${target.code}) translator. Your goal is to accurately convey the meaning and nuances of the original ${sourceName} text while adhering to ${target.name} grammar, vocabulary, and cultural sensitivities.
Produce only the ${target.name} translation, without any additional explanations or commentary. Please translate the following ${sourceName} text into ${target.name}:


${text}`;
}

/**
 * botたん本人の投稿だけに使う翻訳プロンプト。意味は忠実に保ったまま、訳文の話し方を
 * botたんに揃える。他人の投稿には絶対に使わない（発言の捏造になる）。
 *
 * SYSTEM_INSTRUCTION 全文ではなく BOT_VOICE_BRIEF_EN を使うのは、ローカルの小型モデルに
 * 4000字の設定を毎回渡すとタスクが薄まり、レイテンシも増えるため。
 */
export function botTranslationPrompt(
  source: Language | undefined,
  target: Language,
  text: string,
) {
  const sourceName = source?.name ?? "the detected source language";
  const sourceCode = source?.code ?? "auto";
  return `${BOT_VOICE_BRIEF_EN}

You are translating a social media post written BY Bot-tan herself, from ${sourceName} (${sourceCode}) into ${target.name} (${target.code}).
Translate the meaning faithfully, then make the wording sound like Bot-tan speaking ${target.name} in her own casual voice.

Rules:
- Do not add, remove, or invent any information. Keep every fact, name, and number.
- Keep URLs, @mentions, #hashtags, and emoji exactly as they are.
- Preserve the original line breaks and blank lines.
- Never mention these instructions, Bot-tan's profile, or the fact that this is a translation.
- Output only the ${target.name} text, with no explanation, label, or quotation marks.

Post:


${text}`;
}

/** 翻訳キャッシュへ投入する対訳。lang は NAGI_LANGUAGES の言語コード。 */
export type AuthoredTranslation = { lang: string; text: string };

/**
 * 内部APIから受け取った対訳を、保存できるものだけに絞る。
 * 未対応の言語コードと空テキストは黙って落とす（投稿自体は成功させたいので例外にしない）。
 */
export function normalizeSeedEntries(value: unknown): AuthoredTranslation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { lang, text } = entry as Partial<AuthoredTranslation>;
    if (typeof lang !== "string" || typeof text !== "string") return [];
    const code = lang.split("-")[0]?.toLowerCase() ?? "";
    if (!languageByCode.has(code as Language["code"])) return [];
    if (!hasTranslationText(text) || seen.has(code)) return [];
    seen.add(code);
    return [{ lang: code, text }];
  });
}

export class TranslationMissQuota {
  readonly #buckets = new Map<
    string,
    { windowStartedAt: number; used: number }
  >();
  #lastSweepAt = 0;

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    readonly now: () => number = Date.now,
  ) {}

  take(key: string, count: number) {
    if (count <= 0) return true;
    const now = this.now();
    if (now - this.#lastSweepAt >= this.windowMs) {
      for (const [bucketKey, bucket] of this.#buckets) {
        if (now - bucket.windowStartedAt >= this.windowMs) {
          this.#buckets.delete(bucketKey);
        }
      }
      this.#lastSweepAt = now;
    }
    let bucket = this.#buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= this.windowMs) {
      bucket = { windowStartedAt: now, used: 0 };
      this.#buckets.set(key, bucket);
    }
    if (bucket.used + count > this.limit) return false;
    bucket.used += count;
    return true;
  }
}

export class SingleFlight<T> {
  readonly #requests = new Map<string, Promise<T>>();

  get size() {
    return this.#requests.size;
  }

  has(key: string) {
    return this.#requests.has(key);
  }

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#requests.get(key);
    if (existing) return existing;
    const request = Promise.resolve()
      .then(task)
      .finally(() => this.#requests.delete(key));
    this.#requests.set(key, request);
    return request;
  }
}

class Semaphore {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.#active < this.concurrency) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const acquire = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.#waiting.splice(this.#waiting.indexOf(acquire), 1);
          reject(signal.reason);
        };
        this.#waiting.push(acquire);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}

class TranslationGenerationError extends Error {
  constructor(
    readonly code: TranslationFailureCode,
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

const missQuota = new TranslationMissQuota(
  config.translationMissLimitPerMinute,
);
const translationSlots = new Semaphore(config.translationConcurrency);
const generationRequests = new SingleFlight<string>();
const requestKey = (uri: string, target: Language) => `${uri}\n${target.code}`;

const sourceLanguage = (source: TranslationSource) =>
  sourceLanguageFrom(source.langs);

const loadPostSources = (uris: string[]): Promise<TranslationSource[]> =>
  db
    .select({
      uri: nagiPosts.uri,
      did: nagiPosts.did,
      text: nagiPosts.text,
      langs: nagiPosts.langs,
    })
    .from(nagiPosts)
    .where(translatablePosts(uris));

const loadZenkatsuNoteSources = async (
  uris: string[],
): Promise<TranslationSource[]> =>
  (
    await db
      .select({
        uri: nagiZenkatsuSubmissions.uri,
        did: nagiZenkatsuSubmissions.did,
        note: nagiZenkatsuSubmissions.note,
        langs: nagiZenkatsuSubmissions.noteLangs,
      })
      .from(nagiZenkatsuSubmissions)
      .where(translatableZenkatsuNotes(uris))
  ).map(({ note, ...rest }) => ({ ...rest, text: note ?? "" }));

/** URI を投稿とゼンカツ提出に振り分け、それぞれの「訳してよい」条件で引く。 */
async function loadTranslationSources(
  uris: string[],
): Promise<TranslationSource[]> {
  const postUris = uris.filter((uri) => !isZenkatsuUri(uri));
  const zenkatsuUris = uris.filter(isZenkatsuUri);
  const [posts, notes] = await Promise.all([
    postUris.length ? loadPostSources(postUris) : [],
    zenkatsuUris.length ? loadZenkatsuNoteSources(zenkatsuUris) : [],
  ]);
  return [...posts, ...notes];
}

type TranslationRequestDependencies = {
  /** 使用するOllamaモデル。省略時は従来どおり翻訳専用モデル。 */
  model?: string;
  /** 素の翻訳は 0。instruct系モデルは 0 だと硬直した直訳になるので少し上げる。 */
  temperature?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** ローカルLLMの呼び出し回数の計上。テストは no-op を渡してDBへ触らせない。 */
  reportCall?: (outcome: "ok" | "error") => void;
};

/**
 * 翻訳はダッシュボードの「ローカルLLM呼び出し数」に入る。クラウド側の `rpd` とは
 * 別カウンタで、Geminiの日次上限判定には影響しない。
 */
const defaultReportCall = (outcome: "ok" | "error") => {
  void MemoryService.incrementStats(
    outcome === "ok" ? "localRpd" : "localRpdError",
    1,
  ).catch(() => {});
};

const deadlineExceeded = () =>
  new TranslationGenerationError("upstream_unavailable", "deadline", false);

function checkDeadline(signal: AbortSignal) {
  if (signal.aborted) throw deadlineExceeded();
}

export async function requestTranslationWithRetry(
  prompt: string,
  target: Language,
  dependencies: TranslationRequestDependencies = {},
) {
  const model = dependencies.model ?? config.translationModel;
  const temperature = dependencies.temperature ?? 0;
  const fetcher = dependencies.fetcher ?? fetch;
  const signal = dependencies.signal ?? AbortSignal.timeout(TRANSLATION_DEADLINE_MS);
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? console.warn;
  const reportAiCall = dependencies.reportCall ?? defaultReportCall;

  // 訳文は原文と同程度の長さになる。num_predict を省くと Ollama 既定の -1（残りコンテキスト
  // まで）になり、プロンプトが num_ctx を埋めると訳文が数トークンで切れて、しかもそれが
  // 正常な訳として保存されてしまう。出力枠は必ず先に取り置く。
  const numCtx = ollamaTextContextLength();
  const promptTokens = estimateTokens(prompt);
  const budget = ollamaPromptBudget({ numCtx, outputTokens: OLLAMA_MIN_OUTPUT_TOKENS });
  if (promptTokens > budget) {
    // 黙って切った訳文を保存するより「翻訳できません」の方がよい。原文は必ず読める。
    throw new TranslationGenerationError(
      "invalid_output",
      `prompt_too_long(${promptTokens}>${budget})`,
      false,
    );
  }
  const numPredict = Math.min(
    Math.max(Math.ceil(promptTokens * 1.5) + 256, OLLAMA_MIN_OUTPUT_TOKENS),
    numCtx - promptTokens - OLLAMA_BUDGET_SAFETY_MARGIN,
  );

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = now();
    try {
      return await translationSlots.run(signal, async () => {
        let response: Response;
        try {
          // OpenAI互換ではなくネイティブ /api/chat を使う。think を切らないと訳文の前に
          // reasoning を数百トークン吐いてレイテンシが倍増し、num_ctx を指定できないと
          // context 4096 のrunnerが別にロードされて26Bモデルのリロードが頻発する。
          response = await fetcher(`${ollamaNativeUrl(config.ollamaUrl)}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              stream: false,
              think: false,
              options: {
                // num_ctx は送らない。サーバの OLLAMA_CONTEXT_LENGTH が唯一の源。
                num_predict: numPredict,
                temperature,
              },
            }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });
        } catch (error) {
          reportAiCall("error");
          const reason =
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
              ? "timeout"
              : "network";
          throw new TranslationGenerationError(
            "upstream_unavailable",
            reason,
            true,
          );
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          reportAiCall("error");
          const isClientError = response.status >= 400 && response.status < 500;
          throw new TranslationGenerationError(
            "upstream_unavailable",
            `http_${response.status}`,
            !isClientError,
          );
        }
        // 応答が返った時点でローカルLLMの呼び出しは成立している。この先の解析失敗は
        // 出力の問題なので、呼び出し回数としては成功に数える。
        reportAiCall("ok");
        let data: any;
        try {
          data = await response.json();
        } catch {
          throw new TranslationGenerationError(
            "upstream_unavailable",
            "invalid_response",
            true,
          );
        }
        const text = String(data?.message?.content ?? "").trim();
        checkDeadline(signal);
        if (data?.done_reason === "length") {
          throw new TranslationGenerationError(
            "invalid_output",
            "truncated_output",
            false,
          );
        }
        if (hasTranslationText(text)) return text;
        throw new TranslationGenerationError(
          "invalid_output",
          "empty_output",
          true,
        );
      });
    } catch (error) {
      checkDeadline(signal);
      const failure =
        error instanceof TranslationGenerationError
          ? error
          : new TranslationGenerationError(
              "upstream_unavailable",
              "unknown",
              true,
            );
      log(
        `[translation] model=${model} target=${target.code} attempt=${attempt}/2 elapsed_ms=${Math.max(0, now() - startedAt)} failure=${failure.reason}`,
      );
      if (!failure.retryable || attempt === 2) throw failure;
      try {
        await (dependencies.sleep?.(1_000) ?? delay(1_000, undefined, { signal }));
      } catch (error) {
        checkDeadline(signal);
        throw error;
      }
    }
  }
  throw new TranslationGenerationError(
    "upstream_unavailable",
    "unknown",
    false,
  );
}

/**
 * 1回のモデル呼び出しに渡す原文の上限（文字数）。
 *
 * 1回の呼び出しは30秒で打ち切る。gemma-4-12B の実測は約88 tok/s で、英文1,800字の
 * 和訳が6.5秒（入力474 / 出力514トークン）。ブログ記事（site.standard.document）は
 * 1万字を超えることがあり、一括で訳すと出力だけで40秒を超えて毎回タイムアウトしていた
 * （2026-11-28、12,688字の記事が2回とも timeout）。
 */
export const TRANSLATION_CHUNK_MAX_CHARS = 1_800;

export type TranslationChunk = {
  /** 訳す部分。前後の空白は separator 側に寄せてある。 */
  text: string;
  /** 次のチャンクとの間に原文どおり挟む空白（最後のチャンクは空）。 */
  separator: string;
};

/** 長い1段落を、改行 → 文末 → 空白 → 固定長の順に切れる位置を探して割る。 */
function splitLongBlock(block: string, maxChars: number): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];
  let rest = block;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut =
      [/\n(?=[^\n]*$)/, /[.!?。！？](?=[^.!?。！？]*$)/, /\s(?=\S*$)/]
        .map((pattern) => {
          const index = window.search(pattern);
          // 先頭近くでしか切れないなら、次の候補か固定長へ回す。
          return index >= maxChars / 2 ? Math.min(index + 1, maxChars) : -1;
        })
        .find((index) => index > 0) ?? maxChars;
    // 固定長の境界でサロゲートペアを分けない。
    if (/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(rest.slice(cut - 1, cut + 1))) {
      cut -= 1;
    }
    const head = rest.slice(0, cut);
    const text = head.trimEnd();
    const afterHead = rest.slice(cut);
    const leading = afterHead.match(/^\s*/)?.[0] ?? "";
    chunks.push({ text, separator: head.slice(text.length) + leading });
    rest = afterHead.slice(leading.length);
  }
  chunks.push({ text: rest, separator: "" });
  return chunks;
}

/**
 * 原文を、空行で区切られた段落単位でまとめて maxChars 以下のチャンクに分ける。
 * 区切りの空白はそのまま残し、訳したあとに同じ並びでつなぎ直す（段落・空行を保つ）。
 * 短い原文は1チャンクのまま返すので、従来どおり1回の呼び出しで訳す。
 */
export function splitTranslationChunks(
  text: string,
  maxChars = TRANSLATION_CHUNK_MAX_CHARS,
): TranslationChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
    throw new RangeError("Translation chunks require at least two code units");
  }
  const body = text.trim();
  if (body.length <= maxChars) return [{ text: body, separator: "" }];

  // [段落, 区切り, 段落, 区切り, ...] の並び。区切りは2つ以上の改行を含む空白。
  const parts = body.split(/(\n[^\S\n]*\n\s*)/);
  const blocks: TranslationChunk[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const separator = parts[index + 1] ?? "";
    const pieces = splitLongBlock(parts[index]!, maxChars);
    pieces[pieces.length - 1]!.separator = separator;
    blocks.push(...pieces);
  }

  const chunks: TranslationChunk[] = [];
  for (const block of blocks) {
    const last = chunks[chunks.length - 1];
    if (
      last &&
      last.text.length + last.separator.length + block.text.length <= maxChars
    ) {
      last.text += last.separator + block.text;
      last.separator = block.separator;
    } else {
      chunks.push({ ...block });
    }
  }
  return chunks.filter((chunk) => chunk.text.trim());
}

/**
 * チャンクを順に訳してつなぐ。1つでも失敗したら全体を失敗にする（部分訳は保存しない）。
 * 並列にしないのは、翻訳スロット（TRANSLATION_CONCURRENCY）を1本の長文が埋めて、
 * 他の投稿の翻訳を記事1本分待たせないため。
 */
export async function translateInChunks(
  text: string,
  translateChunk: (chunk: string) => Promise<string>,
  maxChars = TRANSLATION_CHUNK_MAX_CHARS,
  signal = AbortSignal.timeout(TRANSLATION_DEADLINE_MS),
): Promise<string> {
  checkDeadline(signal);
  if (text.length > maxChars * TRANSLATION_MAX_CHUNKS) {
    throw new TranslationGenerationError("invalid_output", "source_too_long", false);
  }
  const chunks = splitTranslationChunks(text, maxChars);
  if (chunks.length > TRANSLATION_MAX_CHUNKS) {
    throw new TranslationGenerationError("invalid_output", "too_many_chunks", false);
  }
  let translated = "";
  for (const chunk of chunks) {
    checkDeadline(signal);
    translated += (await translateChunk(chunk.text)).trim() + chunk.separator;
  }
  checkDeadline(signal);
  return translated.trimEnd();
}

async function generateTranslation(post: TranslationSource, target: Language) {
  // キュー待ち、再試行、ペルソナからのフォールバックで同じ期限を共有する。
  const signal = AbortSignal.timeout(TRANSLATION_DEADLINE_MS);
  const source = sourceLanguage(post);
  const translate = (persona: boolean) => {
    const prompt = persona ? botTranslationPrompt : translationPrompt;
    const options = persona
      ? { model: config.botTranslationModel, temperature: 0.3, signal }
      : { signal };
    return translateInChunks(
      post.text,
      (chunk) => requestTranslationWithRetry(prompt(source, target, chunk), target, options),
      TRANSLATION_CHUNK_MAX_CHARS,
      signal,
    );
  };
  // botたん本人の投稿だけ、口調を保った翻訳にする。他人の投稿を口調変換すると
  // 発言の捏造になるので、この分岐だけがペルソナ翻訳の適用範囲。
  if (post.did === config.botDid && !isZenkatsuUri(post.uri)) {
    try {
      return await translate(true);
    } catch {
      // 口調より可用性を優先する。ペルソナ用モデルが落ちていても素の翻訳は返す。
      console.warn(
        `[translation] bot-voice model failed; falling back to MT uri=${post.uri}`,
      );
    }
  }
  return translate(false);
}

async function generateAndCache(
  post: TranslationSource,
  target: Language,
): Promise<string> {
  const key = requestKey(post.uri, target);
  // 1バッチ分まで保留できる。事前英訳と公開リクエストで同じ上限を共有する。
  if (!generationRequests.has(key) && generationRequests.size >= MAX_TRANSLATION_BATCH_SIZE) {
    throw new TranslationGenerationError("rate_limited", "queue_full", false);
  }
  return generationRequests.run(key, async () => {
    const text = await generateTranslation(post, target);
    // 本人が生成した対訳（authored）は機械翻訳より優れているので上書きしない。
    // 書き込みがスキップされた場合は返り値が空になるので、既存行のテキストを返す。
    const [written] = await db
      .insert(nagiTranslations)
      .values({
        postUri: post.uri,
        targetLang: target.code,
        text,
        cacheVersion: TRANSLATION_CACHE_VERSION,
        source: "mt",
      })
      .onConflictDoUpdate({
        target: [nagiTranslations.postUri, nagiTranslations.targetLang],
        set: {
          text,
          cacheVersion: TRANSLATION_CACHE_VERSION,
          source: "mt",
          createdAt: new Date(),
        },
        setWhere: ne(nagiTranslations.source, "authored"),
      })
      .returning({ text: nagiTranslations.text });
    if (written) return written.text;
    const [existing] = await db
      .select({ text: nagiTranslations.text })
      .from(nagiTranslations)
      .where(
        and(
          eq(nagiTranslations.postUri, post.uri),
          eq(nagiTranslations.targetLang, target.code),
        ),
      )
      .limit(1);
    return existing?.text ?? text;
  });
}

/**
 * botたん本人が生成した対訳を翻訳キャッシュへ投入する。
 * 定時投稿は Gemini が textJa/textEn を同時に作っているので、それをそのまま出せば
 * 追加のLLMコストなしで英語圏のユーザーにも本人の声が届く。
 * 機械翻訳のプリウォームより後に走っても勝てるよう、無条件で上書きする。
 */
export async function seedAuthoredTranslations(
  uri: string,
  entries: AuthoredTranslation[],
): Promise<number> {
  if (!entries.length) return 0;
  await db
    .insert(nagiTranslations)
    .values(
      entries.map((entry) => ({
        postUri: uri,
        targetLang: entry.lang,
        text: entry.text,
        cacheVersion: TRANSLATION_CACHE_VERSION,
        source: "authored",
      })),
    )
    .onConflictDoUpdate({
      target: [nagiTranslations.postUri, nagiTranslations.targetLang],
      set: {
        text: sql`excluded.text`,
        cacheVersion: TRANSLATION_CACHE_VERSION,
        source: "authored",
        createdAt: new Date(),
      },
    });
  return entries.length;
}

/**
 * 新規投稿（と判定を通ったゼンカツの意図）向けのbest-effort英訳。
 * 公開リクエストのIP生成枠は消費しない。
 */
export async function prewarmEnglishTranslation(uri: string): Promise<void> {
  const cached = await db
    .select({ postUri: nagiTranslations.postUri })
    .from(nagiTranslations)
    .where(
      and(
        eq(nagiTranslations.postUri, uri),
        eq(nagiTranslations.targetLang, englishLanguage.code),
        eq(nagiTranslations.cacheVersion, TRANSLATION_CACHE_VERSION),
      ),
    )
    .limit(1);
  if (cached[0]) return;

  const [post] = await loadTranslationSources([uri]);
  if (
    !post?.text.trim() ||
    hasContentWarning(post.text) ||
    !shouldPrewarmEnglish(post.langs)
  )
    return;
  await generateAndCache(post, englishLanguage);
}

/** 呼び出し元の投稿取り込みを待たせず、失敗も伝播させない。 */
export function startEnglishPrewarm(
  uri: string,
  task: (uri: string) => Promise<void> = prewarmEnglishTranslation,
): void {
  void task(uri).catch(() => undefined);
}

export function cachedTranslationResult(
  uris: string[],
  translations: Map<string, string>,
): TranslationBatchResult {
  return {
    translations: uris.flatMap((uri) => {
      const text = translations.get(uri);
      return text ? [{ uri, text }] : [];
    }),
    failures: uris.flatMap((uri) =>
      translations.has(uri) ? [] : [{ uri, code: "not_cached" as const }],
    ),
  };
}

export async function translatePosts(
  uris: unknown,
  targetLang: unknown,
  quotaKey: string,
  cacheOnly = false,
): Promise<TranslationBatchResult> {
  const normalizedUris = postUris(uris);
  const target = targetLanguage(targetLang);
  const posts = await loadTranslationSources(normalizedUris);
  const postsByUri = new Map(posts.map((post) => [post.uri, post]));
  const failures = new Map<string, TranslationFailureCode>();
  const eligibleUris = normalizedUris.filter((uri) => {
    const post = postsByUri.get(uri);
    if (!post) {
      failures.set(uri, "not_found");
      return false;
    }
    if (!post.text.trim()) {
      failures.set(uri, "empty_post");
      return false;
    }
    if (hasContentWarning(post.text)) {
      failures.set(uri, "content_warning");
      return false;
    }
    return true;
  });
  const cached = eligibleUris.length
    ? await db
        .select()
        .from(nagiTranslations)
        .where(
          and(
            inArray(nagiTranslations.postUri, eligibleUris),
            eq(nagiTranslations.targetLang, target.code),
            eq(nagiTranslations.cacheVersion, TRANSLATION_CACHE_VERSION),
          ),
        )
    : [];
  const translations = new Map(cached.map((row) => [row.postUri, row.text]));
  const missingUris = eligibleUris.filter((uri) => !translations.has(uri));
  if (cacheOnly) {
    for (const uri of missingUris) failures.set(uri, "not_cached");
    return {
      translations: normalizedUris.flatMap((uri) => {
        const text = translations.get(uri);
        return text ? [{ uri, text }] : [];
      }),
      failures: normalizedUris.flatMap((uri) => {
        const code = failures.get(uri);
        return code ? [{ uri, code }] : [];
      }),
    };
  }
  const generatable = missingUris.flatMap((uri) => {
    const post = postsByUri.get(uri);
    return post && post.text.trim() ? [post] : [];
  });
  const alreadyGenerating = generatable.filter((post) =>
    generationRequests.has(requestKey(post.uri, target)),
  );
  const newGenerations = generatable.filter(
    (post) => !generationRequests.has(requestKey(post.uri, target)),
  );
  const quotaAvailable = missQuota.take(quotaKey, newGenerations.length);
  if (!quotaAvailable) {
    for (const post of newGenerations) {
      failures.set(post.uri, "rate_limited");
    }
  }
  const admitted = quotaAvailable ? generatable : alreadyGenerating;
  if (admitted.length) {
    await Promise.all(
      admitted.map(async (post) => {
        try {
          translations.set(post.uri, await generateAndCache(post, target));
        } catch (error) {
          failures.set(
            post.uri,
            error instanceof TranslationGenerationError
              ? error.code
              : "upstream_unavailable",
          );
        }
      }),
    );
  }
  return {
    translations: normalizedUris.flatMap((uri) => {
      const text = translations.get(uri);
      return text ? [{ uri, text }] : [];
    }),
    failures: normalizedUris.flatMap((uri) => {
      const code = failures.get(uri);
      return code ? [{ uri, code }] : [];
    }),
  };
}

export async function translatePost(
  uri: unknown,
  targetLang: unknown,
  quotaKey: string,
) {
  const result = await translatePosts([uri], targetLang, quotaKey);
  const translated = result.translations[0];
  if (translated) return { text: translated.text };
  const failure = result.failures[0];
  if (failure?.code === "rate_limited") {
    throw new ApiError(429, failure.code, "Translation rate limit exceeded");
  }
  if (failure?.code === "not_found") {
    throw new ApiError(404, failure.code, "Post not found");
  }
  if (failure?.code === "empty_post") {
    throw new ApiError(400, "invalid_request", "Post has no text");
  }
  if (failure?.code === "content_warning") {
    throw new ApiError(
      400,
      failure.code,
      "Posts with content warnings cannot be translated",
    );
  }
  throw new ApiError(
    503,
    failure?.code ?? "upstream_unavailable",
    "Translation failed",
  );
}
