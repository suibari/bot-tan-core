import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import {
  BOT_MEMORY_SOURCE_TYPES,
  buildMemoryContext,
  isBotMemorySourceType,
  recordBotMemoryUsages,
  searchBotMemory,
  type BotMemoryContextRequestBody,
  type BotMemoryPurpose,
  type BotMemorySearchResult,
  type BotMemorySourceType,
  type MemoryContext,
} from "@bsky-affirmative-bot/database";
import type { BotPresence } from "./manager.js";

const PURPOSES = new Set<BotMemoryPurpose>([
  "reply_history",
  "scheduled_post",
  "live_filler",
  "live_reply",
]);

export function isBotMemoryAuthorized(header: string | undefined, secret: string | undefined) {
  if (!secret || !header) return false;
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function validateBotMemorySearchBody(body: any) {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 1_000) throw new Error("query must contain 1-1000 characters");
  const purpose = body?.purpose;
  if (!PURPOSES.has(purpose)) throw new Error("invalid purpose");
  const sources = body?.sources;
  if (sources !== undefined && (
    !Array.isArray(sources) || !sources.every(isBotMemorySourceType)
  )) throw new Error(`sources must use: ${BOT_MEMORY_SOURCE_TYPES.join(", ")}`);
  return { query, purpose: purpose as BotMemoryPurpose, sources };
}

export function validateBotMemoryUsageBody(body: any) {
  const purpose = body?.purpose;
  const documentIds = body?.documentIds;
  if (!PURPOSES.has(purpose) || !Array.isArray(documentIds)) {
    throw new Error("invalid usage");
  }
  return {
    purpose: purpose as BotMemoryPurpose,
    documentIds: [...new Set(documentIds.filter(Number.isInteger))].slice(0, 20),
    outputRef: typeof body?.outputRef === "string" ? body.outputRef : undefined,
  };
}

export function serializeBotMemorySearchResult(result: BotMemorySearchResult) {
  return {
    id: result.id,
    source: result.sourceType,
    content: result.content,
    occurredAt: result.occurredAt,
    metadata: result.metadata,
    relevance: result.relevance,
  };
}

/**
 * `/memory/context` のボディ。
 *
 * `subjectKey` は**フィルタではなく係数**。指定してもその人以外の記憶は落ちない
 * （buildMemoryContext が本人レグを重み付けして全体レグと畳む）。
 */
export function validateBotMemoryContextBody(body: any) {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (query.length > 1_000) throw new Error("query must contain at most 1000 characters");
  const purpose = body?.purpose;
  if (!PURPOSES.has(purpose)) throw new Error("invalid purpose");
  const sources = body?.sources;
  if (sources !== undefined && (
    !Array.isArray(sources) || !sources.every(isBotMemorySourceType)
  )) throw new Error(`sources must use: ${BOT_MEMORY_SOURCE_TYPES.join(", ")}`);
  const subjectWeight = body?.subjectWeight;
  if (subjectWeight !== undefined && (
    typeof subjectWeight !== "number" || !Number.isFinite(subjectWeight) ||
    subjectWeight < 1 || subjectWeight > 10
  )) throw new Error("subjectWeight must be a number between 1 and 10");
  const digestDays = body?.digestDays;
  if (digestDays !== undefined && (
    !Number.isInteger(digestDays) || digestDays < 0 || digestDays > 30
  )) throw new Error("digestDays must be an integer between 0 and 30");
  return {
    query,
    purpose: purpose as BotMemoryPurpose,
    sources: sources as BotMemorySourceType[] | undefined,
    subjectKey: typeof body?.subjectKey === "string" && body.subjectKey.trim()
      ? body.subjectKey.trim()
      : undefined,
    subjectWeight,
    digestDays,
    limit: Number.isInteger(body?.limit) ? body.limit : undefined,
    researchLimit: Number.isInteger(body?.researchLimit) ? body.researchLimit : undefined,
    excludeDocumentIds: Array.isArray(body?.excludeDocumentIds)
      ? body.excludeDocumentIds.filter(Number.isInteger)
      : undefined,
  } satisfies BotMemoryContextRequestBody;
}

/**
 * 検索結果と同じく、作者・元URI・内部source IDは外部クライアントへ返さない。
 * ダイジェストの highlights も本文の抜粋だけで、誰の発言かは載せない。
 */
export function serializeMemoryContext(context: MemoryContext) {
  return {
    recent: context.recent.map((digest) => ({
      date: digest.digestDate,
      summary: digest.summaryJa,
      highlights: digest.highlights.map((item) => ({
        excerpt: item.excerpt,
        surface: item.surface,
      })),
    })),
    related: context.related.map(serializeBotMemorySearchResult),
    friend: context.friend ? serializeBotMemorySearchResult(context.friend) : null,
    research: context.research.map(serializeBotMemorySearchResult),
  };
}

function parseDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("date must be an ISO string");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid date");
  return parsed;
}

/** 直近の行動の 1 件（biorhythm_history）。energy は 0〜100 */
export type BotActivity = {
  status: string;
  mood: string;
  energy: number;
  createdAt: string;
};

export type BotMemoryRouterOptions = {
  /** いまの様子を返す。無ければ GET /bot/presence は 503 */
  getPresence?: () => BotPresence;
  /** 今日の予定表の日付と服。無ければ GET /bot/daily-plan は 503 */
  getDailyPlan?: () => Promise<{ botDate: string; outfit: string } | undefined>;
  /** since 以降の行動を新しい順に limit 件まで。無ければ GET /bot/activities は 503 */
  getActivities?: (since: Date, limit: number) => Promise<BotActivity[]>;
};

const ACTIVITY_MAX_HOURS = 48;
const ACTIVITY_MAX_LIMIT = 20;

/** GET /bot/activities の hours・limit。範囲外や数でないものは 400 */
export function validateBotActivitiesQuery(query: Record<string, unknown>) {
  const hours = query.hours === undefined ? 18 : Number(query.hours);
  const limit = query.limit === undefined ? 8 : Number(query.limit);
  if (!Number.isFinite(hours) || hours <= 0 || hours > ACTIVITY_MAX_HOURS) {
    throw new Error(`hours must be within 0-${ACTIVITY_MAX_HOURS}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
    throw new Error(`limit must be within 1-${ACTIVITY_MAX_LIMIT}`);
  }
  return { hours, limit };
}

/** GET /bot/presence の応答。決めた項目だけを返す（増えた内部の値を素通しにしない） */
export function serializeBotPresence(presence: BotPresence) {
  return {
    status: presence.status,
    energy: presence.energy,
    mood: presence.mood,
    moodEn: presence.moodEn,
    weather: presence.weather,
    nextStepTime: presence.nextStepTime,
  };
}

export function createBotMemoryRouter(secret: string | undefined, options: BotMemoryRouterOptions = {}) {
  const router = Router();
  router.use((req, res, next) => {
    if (!secret) {
      res.status(503).json({ error: "server not configured" });
      return;
    }
    if (!isBotMemoryAuthorized(req.headers.authorization, secret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  /**
   * いまの様子（状態・元気・行動・天気）。bot-tan-convo の声の会話が、聞かれたら答えるために使う。
   * 公開ダッシュボードの WebSocket と同じ値の一部だが、こちらは LAN の内部 API として認証つきで返す。
   * mood にはお部屋に来た人の表示名が入りうる（publicApi.ts の注記と同じ）ので、外へは出さない。
   */
  router.get("/bot/presence", (_req, res) => {
    if (!options.getPresence) {
      res.status(503).json({ error: "presence not available" });
      return;
    }
    res.json(serializeBotPresence(options.getPresence()));
  });

  /** 今日の予定表の日付と服。予定表がまだ無ければ 404 */
  router.get("/bot/daily-plan", async (_req, res) => {
    if (!options.getDailyPlan) {
      res.status(503).json({ error: "daily plan not available" });
      return;
    }
    try {
      const plan = await options.getDailyPlan();
      if (!plan) {
        res.status(404).json({ error: "no daily plan" });
        return;
      }
      res.json({ botDate: plan.botDate, outfit: plan.outfit });
    } catch (error) {
      console.error("[ERROR][BOT_MEMORY_API] daily plan failed", error);
      res.status(500).json({ error: "daily plan failed" });
    }
  });

  /** 直近の行動（新しい順）。?hours=18&limit=8 が既定 */
  router.get("/bot/activities", async (req, res) => {
    if (!options.getActivities) {
      res.status(503).json({ error: "activities not available" });
      return;
    }
    let query;
    try {
      query = validateBotActivitiesQuery(req.query as Record<string, unknown>);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    try {
      const since = new Date(Date.now() - query.hours * 3_600_000);
      const activities = await options.getActivities(since, query.limit);
      res.json({
        activities: activities.slice(0, query.limit).map((a) => ({
          status: a.status, mood: a.mood, energy: a.energy, createdAt: a.createdAt,
        })),
      });
    } catch (error) {
      console.error("[ERROR][BOT_MEMORY_API] activities failed", error);
      res.status(500).json({ error: "activities failed" });
    }
  });

  router.post("/memory/search", async (req, res) => {
    try {
      const { query, purpose, sources } = validateBotMemorySearchBody(req.body);
      const results = await searchBotMemory({
        query,
        purpose,
        sources,
        authorId: typeof req.body?.authorId === "string" ? req.body.authorId : undefined,
        excludeAuthorId:
          typeof req.body?.excludeAuthorId === "string"
            ? req.body.excludeAuthorId
            : undefined,
        since: parseDate(req.body?.since),
        until: parseDate(req.body?.until),
        excludeDocumentIds: Array.isArray(req.body?.excludeDocumentIds)
          ? req.body.excludeDocumentIds.filter(Number.isInteger)
          : undefined,
        limit: Number.isInteger(req.body?.limit) ? req.body.limit : undefined,
      });
      // Python/YouTube クライアントへは作者、元URI、内部source IDを渡さない。
      res.json({
        memories: results.map(serializeBotMemorySearchResult),
      });
    } catch (error) {
      if (error instanceof Error && (
        error.message.startsWith("query ") ||
        error.message.startsWith("invalid purpose") ||
        error.message.startsWith("sources ") ||
        error.message.includes("date")
      )) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[ERROR][BOT_MEMORY_API] search failed", error);
      res.status(500).json({ error: "memory search failed" });
    }
  });

  /**
   * 三層記憶をまとめて返す統合エンドポイント。
   *
   * - recent: 短期。時間で引いたダイジェストで、検索を通していない
   * - related: 中期。subjectKey の記憶を係数で強めた順位表
   * - research: 外部知識。related の枠を食わせないため別枠
   */
  router.post("/memory/context", async (req, res) => {
    try {
      const request = validateBotMemoryContextBody(req.body);
      const context = await buildMemoryContext(request);
      res.json(serializeMemoryContext(context));
    } catch (error) {
      if (error instanceof Error && (
        error.message.startsWith("query ") ||
        error.message.startsWith("invalid purpose") ||
        error.message.startsWith("sources ") ||
        error.message.startsWith("subjectWeight ") ||
        error.message.startsWith("digestDays ")
      )) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[ERROR][BOT_MEMORY_API] context failed", error);
      res.status(500).json({ error: "memory context failed" });
    }
  });

  router.post("/memory/usages", async (req, res) => {
    try {
      const { purpose, documentIds, outputRef } = validateBotMemoryUsageBody(req.body);
      await recordBotMemoryUsages(documentIds, purpose, outputRef);
      res.json({ success: true, recorded: documentIds.length });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid usage") {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error("[ERROR][BOT_MEMORY_API] usage failed", error);
      res.status(500).json({ error: "memory usage failed" });
    }
  });
  return router;
}
