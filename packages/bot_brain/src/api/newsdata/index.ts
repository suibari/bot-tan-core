import {
  OLLAMA_TEXT_CONTEXT_LENGTH,
  aiModel,
} from "@bsky-affirmative-bot/shared-configs";
import { createHash } from "node:crypto";
import { db, nagiNewsScreening } from "@bsky-affirmative-bot/database";
import { and, eq, gt } from "drizzle-orm";

const NEWSDATA_ENDPOINT = "https://newsdata.io/api/1/latest";
const CACHE_TTL_MS = 30 * 60 * 1000;
const GEMMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SCREENING_POLICY_VERSION = "positive-news-coarse-v3";
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
- 記事の主眼と、確定した最終的な着地点が明確に前向きである。
- 発見、誕生、受賞、優勝、完全復旧、完全回復、完治、寛解、目標達成など、前向きな結果がすでに実現している。
- 自然災害や困難な背景があっても、記事の中心が完全復旧や達成結果なら採用できる。

不採用条件:
- 政治、選挙、外交、戦争、紛争、犯罪、事件、事故が記事の中心である。
- 家畜伝染病・感染症の発生や拡大、防疫措置、殺処分（豚熱、鳥インフルエンザ、口蹄疫など）が記事の中心である。
- 復旧中、改善傾向、可能性、見込み、募集中、発生中など、結果が未確定である。
- 病気、闘病、負傷は、完全回復・完治・寛解が明記されていない。
- 明らかな商品・サービス・店舗・イベントの宣伝や販促が記事の中心である。
- 媒体名が明確なプレスリリース配信サービスを示している。
- 暗い状態の報告、単なる予定・解説、または判断が曖昧である。

注意: 「措置・対応・作業の終了/完了」自体は前向きな成果ではありません。人や地域に利益をもたらす復旧・回復・達成がある場合だけ成果とみなしてください。

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
    link: asOptionalString(article.link),
    publishedAt: asOptionalString(article.pubDate),
    categories: Array.isArray(article.category)
      ? article.category.filter((item): item is string => typeof item === "string")
      : [],
  };
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

    const accepted: PositiveNewsCandidate[] = [];
    const seenIds = new Set<string>();
    let page: string | undefined;

    for (let pageIndex = 0; pageIndex < Math.min(MAX_PAGES, Math.max(0, options.maxPages ?? MAX_PAGES)); pageIndex++) {
      let response: NewsDataResponse;
      try {
        const fetched = await this.fetchNewsPageCached(apiKey, page, options.forceRefresh === true);
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
        if (decision.decision === "accept" && !decision.promotional) {
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

  private pageCacheKey(page?: string) {
    return `ja|jp|10|politics,crime|top|${page ?? "first"}`;
  }

  private async fetchNewsPageCached(apiKey: string, page?: string, forceRefresh = false) {
    const key = this.pageCacheKey(page);
    const cached = this.pageCache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return { response: cached.result, cacheHit: true };
    const running = this.pageInflight.get(key);
    if (!forceRefresh && running) return { response: await running, cacheHit: true };
    const promise = this.fetchNewsPage(apiKey, page);
    this.pageInflight.set(key, promise);
    try {
      const response = await promise;
      this.pageCache.set(key, { result: response, expiresAt: this.now() + CACHE_TTL_MS });
      this.logger.log(`[INFO][NEWS][USAGE] NewsData credit=1 page=${page ?? "first"}`);
      return { response, cacheHit: false };
    } finally {
      if (this.pageInflight.get(key) === promise) this.pageInflight.delete(key);
    }
  }

  private async fetchNewsPage(apiKey: string, page?: string): Promise<NewsDataResponse> {
    const query = new URLSearchParams({
      apikey: apiKey,
      language: "ja",
      country: "jp",
      size: String(PAGE_SIZE),
      removeduplicate: "1",
      excludecategory: "politics,crime",
      excludedomain: "news.google.com",
      prioritydomain: "top",
    });
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
          // num_ctx は他のローカル呼び出しと必ず揃える（ずれるとrunnerが作り直される）。
          options: {
            num_ctx: OLLAMA_TEXT_CONTEXT_LENGTH,
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
