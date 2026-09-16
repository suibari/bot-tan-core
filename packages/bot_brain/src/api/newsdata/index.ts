import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import { reportAiCallAsync } from "../../ai/aiCallStats.js";
import { createHash } from "node:crypto";
import { db, nagiNewsScreening } from "@bsky-affirmative-bot/database";
import { and, eq, gt } from "drizzle-orm";

const NEWSDATA_ENDPOINT = "https://newsdata.io/api/1/latest";
const CACHE_TTL_MS = 30 * 60 * 1000;
const GEMMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SCREENING_POLICY_VERSION = "positive-news-coarse-v4";
const MAX_PAGES = 3;
const PAGE_SIZE = 10;
const TARGET_CANDIDATES = 5;
const CLASSIFIER_CONCURRENCY = 2;
const DESCRIPTION_LIMIT = 1_200;

const REASON_CODES = [
  "positive_result",
  "promotion",
  "excluded_topic",
  "unresolved",
  "health_not_complete",
  "unclear",
  "classifier_error",
] as const;

export type NewsDecisionReason = (typeof REASON_CODES)[number];

export interface PositiveNewsCandidate {
  articleId: string;
  title: string;
  description?: string;
  sourceName?: string;
  sourceUrl?: string;
  imageUrl?: string;
  link?: string;
  publishedAt?: string;
  categories: string[];
}

export interface NewsScreeningDecision {
  article: PositiveNewsCandidate;
  decision: "accept" | "reject";
  promotional: boolean;
  reasonCode: NewsDecisionReason;
}

export interface NewsScreeningDiagnostics {
  cacheHit: boolean;
  totalResults: number;
  pagesFetched: number;
  /** この取得で使った関心ジャンルの検索式。無指定取得なら undefined。 */
  topicQuery?: string;
  /** この呼び出しで実際にNewsDataへ到達した回数（キャッシュヒットは0）。 */
  creditsUsed: number;
  articlesFetched: number;
  decisions: NewsScreeningDecision[];
  errors: string[];
}

export interface PositiveNewsResult {
  candidates: PositiveNewsCandidate[];
  diagnostics: NewsScreeningDiagnostics;
}

interface NewsDataArticleResponse {
  article_id?: unknown;
  title?: unknown;
  description?: unknown;
  source_name?: unknown;
  source_url?: unknown;
  image_url?: unknown;
  link?: unknown;
  pubDate?: unknown;
  category?: unknown;
}

interface NewsDataResponse {
  status?: unknown;
  totalResults?: unknown;
  results?: unknown;
  nextPage?: unknown;
}

export interface PositiveNewsServiceDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  getNewsDataApiKey?: () => string | undefined;
  getOllamaBaseUrl?: () => string | undefined;
  getOllamaModel?: () => string;
  logger?: Pick<Console, "log" | "warn">;
  getPersistentScreening?: (key: string, now: Date) => Promise<{ decision: "accept" | "reject"; reasonCode: NewsDecisionReason } | undefined>;
  setPersistentScreening?: (key: string, articleId: string, decision: NewsScreeningDecision, expiresAt: Date) => Promise<void>;
}

export interface GetPositiveNewsOptions {
  excludeArticleIds?: Iterable<string>;
  forceRefresh?: boolean;
  maxPages?: number;
  /**
   * 関心ジャンルの検索式（NewsData の q）。渡すと「日本の最新ニュース」ではなく
   * そのジャンルの中から拾う。**広いジャンル語であること**が前提で、作品名のような
   * 固有名を入れてはいけない（当たりが宣伝と公式発表に偏り、当たらない日は0件になる）。
   * 一般化は newsInterestTopics.ts が担当する。
   */
  topicQuery?: string;
}

interface CachedResult<T> {
  expiresAt: number;
  result: T;
}

const CLASSIFIER_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["accept", "reject"] },
    promotional: { type: "boolean" },
    reasonCode: {
      type: "string",
      enum: REASON_CODES.filter((reason) => reason !== "classifier_error"),
    },
  },
  required: ["decision", "promotional", "reasonCode"],
} as const;

const CLASSIFIER_SYSTEM_PROMPT = `あなたは「全肯定ニュース」の候補を1件だけ粗選別する担当です。

採用条件:
- 読んで前向きになれる、楽しい、面白い、ほっこりする、または役に立つ無害な話題である。
- 発見、誕生、受賞、優勝、完成、復旧、回復、目標達成など、前向きな成果がある。
- 自然災害や困難な背景があっても、記事の中心が完全復旧や達成結果なら採用できる。
- アニメ・マンガ・ゲームなどのイベント開催、新展開、コラボ、新商品、グッズの紹介は、宣伝を兼ねていても、ファンが楽しめる明るい話題なら採用できる。
- 身近な疑問、文化の変化、制作上の工夫など、結論が勝敗や成果でなくても、興味深く無害な読み物なら採用できる。

不採用条件:
- 政治、選挙、外交、戦争、紛争、犯罪、事件、事故が記事の中心である。
- 家畜伝染病・感染症の発生や拡大、防疫措置、殺処分（豚熱、鳥インフルエンザ、口蹄疫など）が記事の中心である。
- 病気、闘病、負傷は、完全回復・完治・寛解が明記されていない。
- 値引き、割引率、ポイント還元、クーポン、タイムセールなど、安く買えることだけが主題の販売情報である。
- 商品やサービスを買わせることだけが目的で、楽しさ・面白さ・新しい出来事としての読みどころがない。
- 暗い状態の報告、人を嘲笑する話題、または内容が乏しく明るい読み物か判断できない。

注意:
- promotional は記事に宣伝性があるかを示す診断値です。promotional=true だけを理由に reject にしてはいけません。
- セール情報を reject にするときは decision=reject, reasonCode=promotion にしてください。
- 宣伝性があっても明るく楽しい内容を accept にするときは decision=accept, reasonCode=positive_result にしてください。
- 「措置・対応・作業の終了/完了」自体は前向きな成果ではありません。人や地域に利益をもたらす復旧・回復・達成がある場合だけ成果とみなしてください。

迷う場合は reject にしてください。JSON Schemaどおりにだけ回答してください。`;

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArticle(value: unknown): PositiveNewsCandidate | null {
  if (!value || typeof value !== "object") return null;
  const article = value as NewsDataArticleResponse;
  const articleId = asOptionalString(article.article_id);
  const title = asOptionalString(article.title);
  if (!articleId || !title) return null;

  return {
    articleId,
    title,
    description: asOptionalString(article.description)?.slice(0, DESCRIPTION_LIMIT),
    sourceName: asOptionalString(article.source_name),
    sourceUrl: asOptionalString(article.source_url),
    imageUrl: asOptionalHttpsUrl(article.image_url),
    link: asOptionalString(article.link),
    publishedAt: asOptionalString(article.pubDate),
    categories: Array.isArray(article.category)
      ? article.category.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function asOptionalHttpsUrl(value: unknown): string | undefined {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

export class PositiveNewsService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly getNewsDataApiKey: () => string | undefined;
  private readonly getOllamaBaseUrl: () => string | undefined;
  private readonly getOllamaModel: () => string;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly getPersistentScreening?: PositiveNewsServiceDependencies["getPersistentScreening"];
  private readonly setPersistentScreening?: PositiveNewsServiceDependencies["setPersistentScreening"];
  private readonly pageCache = new Map<string, CachedResult<NewsDataResponse>>();
  private readonly pageInflight = new Map<string, Promise<NewsDataResponse>>();
  private readonly screeningCache = new Map<string, CachedResult<NewsScreeningDecision>>();
  private readonly screeningInflight = new Map<string, Promise<NewsScreeningDecision>>();

  constructor(dependencies: PositiveNewsServiceDependencies = {}) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.getNewsDataApiKey = dependencies.getNewsDataApiKey
      ?? (() => process.env.NEWSDATA_API_KEY);
    this.getOllamaBaseUrl = dependencies.getOllamaBaseUrl
      ?? (() => process.env.OLLAMA_BASE_URL);
    this.getOllamaModel = dependencies.getOllamaModel
      ?? (() => aiModel("OLLAMA_NEWS_PRESCREEN"));
    this.logger = dependencies.logger ?? console;
    this.getPersistentScreening = dependencies.getPersistentScreening;
    this.setPersistentScreening = dependencies.setPersistentScreening;
  }

  clearCache() {
    this.pageCache.clear();
    this.pageInflight.clear();
    this.screeningCache.clear();
    this.screeningInflight.clear();
  }

  async getCandidates(options: GetPositiveNewsOptions = {}): Promise<PositiveNewsResult> {
    const excludedIds = new Set(options.excludeArticleIds ?? []);
    const diagnostics: NewsScreeningDiagnostics = {
      cacheHit: false,
      totalResults: 0,
      pagesFetched: 0,
      creditsUsed: 0,
      articlesFetched: 0,
      decisions: [],
      errors: [],
    };
    const apiKey = this.getNewsDataApiKey()?.trim();
    if (!apiKey) {
      diagnostics.errors.push("NEWSDATA_API_KEY is not configured");
      this.logger.warn("[WARN][NEWS] NEWSDATA_API_KEY is not configured; skipping news.");
      return { candidates: [], diagnostics };
    }

    const topicQuery = options.topicQuery?.trim() || undefined;
    diagnostics.topicQuery = topicQuery;

    const accepted: PositiveNewsCandidate[] = [];
    const seenIds = new Set<string>();
    let page: string | undefined;

    for (let pageIndex = 0; pageIndex < Math.min(MAX_PAGES, Math.max(0, options.maxPages ?? MAX_PAGES)); pageIndex++) {
      let response: NewsDataResponse;
      try {
        const fetched = await this.fetchNewsPageCached(apiKey, page, options.forceRefresh === true, topicQuery);
        response = fetched.response;
        if (!fetched.cacheHit) diagnostics.creditsUsed++;
        diagnostics.cacheHit = diagnostics.pagesFetched === 0 ? fetched.cacheHit : diagnostics.cacheHit && fetched.cacheHit;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.errors.push(message);
        this.logger.warn(`[WARN][NEWS] NewsData request failed: ${message}`);
        break;
      }

      diagnostics.pagesFetched++;
      if (pageIndex === 0 && typeof response.totalResults === "number") {
        diagnostics.totalResults = response.totalResults;
      }

      const articles = Array.isArray(response.results)
        ? response.results.map(normalizeArticle).filter((article): article is PositiveNewsCandidate => !!article)
        : [];
      diagnostics.articlesFetched += articles.length;

      const pageCandidates = articles.filter((article) => {
        if (seenIds.has(article.articleId) || excludedIds.has(article.articleId)) return false;
        seenIds.add(article.articleId);
        return true;
      });

      const decisions = await mapWithConcurrency(
        pageCandidates,
        CLASSIFIER_CONCURRENCY,
        (article) => this.classifyArticle(article),
      );
      diagnostics.decisions.push(...decisions);

      for (const decision of decisions) {
        this.logger.log(
          `[INFO][NEWS] article=${decision.article.articleId} source=${decision.article.sourceName ?? "unknown"} decision=${decision.decision} reason=${decision.reasonCode} promotional=${decision.promotional}`,
        );
        if (decision.decision === "accept") {
          accepted.push(decision.article);
        }
      }

      if (accepted.length >= TARGET_CANDIDATES) break;
      page = asOptionalString(response.nextPage);
      if (!page) break;
    }

    return {
      candidates: accepted.slice(0, TARGET_CANDIDATES),
      diagnostics,
    };
  }

  private pageCacheKey(page?: string, topicQuery?: string) {
    // 検索式をキーに含めないと、ジャンル指定の取得と無指定の取得が同じページを
    // 共有してしまう（片方の結果がもう片方のクレジット節約に化ける）。
    return `ja|jp|10|politics,crime|${topicQuery ? `q:${topicQuery}|medium` : "top"}|${page ?? "first"}`;
  }

  private async fetchNewsPageCached(apiKey: string, page?: string, forceRefresh = false, topicQuery?: string) {
    const key = this.pageCacheKey(page, topicQuery);
    const cached = this.pageCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return { response: cached.result, cacheHit: true };
    const running = this.pageInflight.get(key);
    if (!forceRefresh && running) return { response: await running, cacheHit: true };
    const promise = this.fetchNewsPage(apiKey, page, topicQuery);
    this.pageInflight.set(key, promise);
    try {
      const response = await promise;
      this.pageCache.set(key, { result: response, expiresAt: this.now() + CACHE_TTL_MS });
      this.logger.log(`[INFO][NEWS][USAGE] NewsData credit=1 page=${page ?? "first"} q=${topicQuery ?? "-"}`);
      return { response, cacheHit: false };
    } finally {
      if (this.pageInflight.get(key) === promise) this.pageInflight.delete(key);
    }
  }

  private async fetchNewsPage(apiKey: string, page?: string, topicQuery?: string): Promise<NewsDataResponse> {
    const query = new URLSearchParams({
      apikey: apiKey,
      language: "ja",
      country: "jp",
      size: String(PAGE_SIZE),
      removeduplicate: "1",
      excludecategory: "politics,crime",
      excludedomain: "news.google.com",
      // ジャンルを絞るときは配信元も絞ると1ページが空になりやすいので medium まで広げる。
      // セールだけの記事や暗い話題は粗選別と最終ゲートが落とすので、ここで配信元を
      // 絞り込む必要はない。無指定取得は従来どおり top のまま。
      prioritydomain: topicQuery ? "medium" : "top",
    });
    if (topicQuery) query.set("q", topicQuery);
    if (page) query.set("page", page);

    const response = await this.fetchImpl(`${NEWSDATA_ENDPOINT}?${query.toString()}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json() as NewsDataResponse;
    if (!response.ok || data.status !== "success") {
      throw new Error(`NewsData HTTP ${response.status}`);
    }
    return data;
  }

  private async classifyArticle(article: PositiveNewsCandidate): Promise<NewsScreeningDecision> {
    const contentHash = createHash("sha256").update(`${article.title}\n${article.description ?? ""}`).digest("hex");
    const cacheKey = `${SCREENING_POLICY_VERSION}:${article.articleId}:${contentHash}`;
    const cached = this.screeningCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.result;
    const running = this.screeningInflight.get(cacheKey);
    if (running) return running;
    const promise = (async () => {
      const persistent = await this.getPersistentScreening?.(cacheKey, new Date(this.now()));
      if (persistent) {
        const result: NewsScreeningDecision = { article, decision: persistent.decision, promotional: false, reasonCode: persistent.reasonCode };
        this.screeningCache.set(cacheKey, { result, expiresAt: this.now() + GEMMA_CACHE_TTL_MS });
        return result;
      }
      const result = await this.classifyArticleUncached(article);
      this.screeningCache.set(cacheKey, { result, expiresAt: this.now() + GEMMA_CACHE_TTL_MS });
      await this.setPersistentScreening?.(cacheKey, article.articleId, result, new Date(this.now() + GEMMA_CACHE_TTL_MS)).catch((error) => this.logger.warn(`[WARN][NEWS] Failed to persist Gemma cache: ${error}`));
      return result;
    })();
    this.screeningInflight.set(cacheKey, promise);
    try { return await promise; }
    finally { if (this.screeningInflight.get(cacheKey) === promise) this.screeningInflight.delete(cacheKey); }
  }

  private async classifyArticleUncached(article: PositiveNewsCandidate): Promise<NewsScreeningDecision> {
    const ollamaBaseUrl = this.getOllamaBaseUrl()?.trim();
    if (!ollamaBaseUrl) return this.classifierError(article, "OLLAMA_BASE_URL is not configured");

    const rootUrl = ollamaBaseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const userContent = [
      `媒体: ${article.sourceName ?? "不明"}`,
      `見出し: ${article.title}`,
      `説明: ${article.description ?? "なし"}`,
    ].join("\n");

    let called = false;
    try {
      const response = await this.fetchImpl(`${rootUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.getOllamaModel(),
          stream: false,
          // 思考するモデルは reasoning が num_predict を食い切り、content が空文字のまま
          // done_reason=length で返る。そのまま JSON.parse("") に落ちて全件 classifier_error
          // になるため、format を付けていても think は必ず切る。
          think: false,
          format: CLASSIFIER_SCHEMA,
          keep_alive: "10m",
          // num_ctx は送らない。サーバの OLLAMA_CONTEXT_LENGTH が唯一の源。
          options: {
            temperature: 0,
            num_predict: 100,
          },
          messages: [
            { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      // ここは generateContentForProvider を通らないので、呼び出し回数を自分で数える。
      // 応答が返った時点で ok。この先の JSON 解析失敗は「呼び出しは成功したが出力が
      // 不正」なので、呼び出し回数としては成功に数える。
      reportAiCallAsync("ollama", "ok");
      called = true;

      const data = await response.json() as { message?: { content?: unknown } };
      const content = typeof data.message?.content === "string" ? data.message.content : "";
      const parsed = JSON.parse(content) as {
        decision?: unknown;
        promotional?: unknown;
        reasonCode?: unknown;
      };
      const reasonCode = REASON_CODES.includes(parsed.reasonCode as NewsDecisionReason)
        && parsed.reasonCode !== "classifier_error"
        ? parsed.reasonCode as NewsDecisionReason
        : null;
      if (
        (parsed.decision !== "accept" && parsed.decision !== "reject")
        || typeof parsed.promotional !== "boolean"
        || !reasonCode
      ) {
        throw new Error("Ollama returned an invalid classification");
      }

      return {
        article,
        decision: parsed.decision,
        promotional: parsed.promotional,
        reasonCode,
      };
    } catch (error) {
      if (!called) reportAiCallAsync("ollama", "error");
      const message = error instanceof Error ? error.message : String(error);
      return this.classifierError(article, message);
    }
  }

  private classifierError(article: PositiveNewsCandidate, message: string): NewsScreeningDecision {
    this.logger.warn(`[WARN][NEWS] Ollama classification failed for ${article.articleId}: ${message}`);
    return {
      article,
      decision: "reject",
      promotional: false,
      reasonCode: "classifier_error",
    };
  }
}

export const positiveNewsService = new PositiveNewsService({
  getPersistentScreening: async (key, now) => {
    const rows = await db.select({ decision: nagiNewsScreening.decision, reasonCode: nagiNewsScreening.reasonCode }).from(nagiNewsScreening)
      .where(and(eq(nagiNewsScreening.cacheKey, key), gt(nagiNewsScreening.expiresAt, now))).limit(1);
    const row = rows[0];
    if (!row || (row.decision !== "accept" && row.decision !== "reject") || !REASON_CODES.includes(row.reasonCode as NewsDecisionReason)) return undefined;
    return { decision: row.decision, reasonCode: row.reasonCode as NewsDecisionReason };
  },
  setPersistentScreening: async (key, articleId, decision, expiresAt) => {
    await db.insert(nagiNewsScreening).values({ cacheKey: key, articleId, decision: decision.decision, reasonCode: decision.reasonCode, expiresAt })
      .onConflictDoUpdate({ target: nagiNewsScreening.cacheKey, set: { decision: decision.decision, reasonCode: decision.reasonCode, expiresAt } });
  },
});

export function getPositiveNewsCandidates(options: GetPositiveNewsOptions = {}) {
  return positiveNewsService.getCandidates(options);
}
