import {
  db,
  nagiAiReplyRequests,
  nagiBotReplyJobs,
} from "@bsky-affirmative-bot/database";
import { aiTextProvider } from "@bsky-affirmative-bot/shared-configs";
import { and, eq, gte, lt, sql } from "drizzle-orm";

export type NagiReplyMode = "ai" | "template";
export type NagiAiLimitReason =
  "user_10m" | "user_24h" | "service_10m" | "service_24h";

const minutes = (value: number) => value * 60_000;
const hours = (value: number) => value * 60 * 60_000;

const positiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const nagiAiQuotaConfig = {
  user10m: positiveInteger("NAGI_AI_USER_10M_LIMIT", 10),
  user24h: positiveInteger("NAGI_AI_USER_24H_LIMIT", 60),
  service10m: positiveInteger("NAGI_AI_SERVICE_10M_LIMIT", 300),
  service24h: positiveInteger("NAGI_AI_SERVICE_24H_LIMIT", 2_000),
};

const USER_LOCK_KEY = "nagi-ai-user-quota-v1";
const SERVICE_LOCK_KEY = "nagi-ai-service-quota-v1";

const countOf = (value: unknown) => Number(value ?? 0);

export function quotaCountSince(
  column:
    | typeof nagiBotReplyJobs.modeDecidedAt
    | typeof nagiAiReplyRequests.requestedAt,
  since: Date,
) {
  // sql`` に Date を直接埋めるとカラムの encoder が働かず、postgres-js が
  // Date を文字列としてbindしようとして ERR_INVALID_ARG_TYPE になる。
  return sql<number>`count(*) filter (where ${gte(column, since)})`;
}

export function userLimitReason(
  recentCount: number,
  dailyCount: number,
  limits = nagiAiQuotaConfig,
): Extract<NagiAiLimitReason, "user_10m" | "user_24h"> | undefined {
  if (recentCount >= limits.user10m) return "user_10m";
  if (dailyCount >= limits.user24h) return "user_24h";
  return undefined;
}

export function serviceLimitReason(
  recentCount: number,
  dailyCount: number,
  limits = nagiAiQuotaConfig,
): Extract<NagiAiLimitReason, "service_10m" | "service_24h"> | undefined {
  if (recentCount >= limits.service10m) return "service_10m";
  if (dailyCount >= limits.service24h) return "service_24h";
  return undefined;
}

function logLimit(reason: NagiAiLimitReason, sourceUri?: string) {
  console.info(
    JSON.stringify({
      level: "info",
      event: "nagi_ai_reply_limited",
      reason,
      ...(sourceUri ? { sourceUri } : {}),
    }),
  );
}

export async function decideNagiReplyMode(
  sourceUri: string,
  authorDid: string,
  now = new Date(),
): Promise<{ mode: NagiReplyMode; reason?: NagiAiLimitReason }> {
  // ローカル生成はGemini課金枠を消費しないため、ユーザー別quotaで定型文へ落とさない。
  // provider の解釈は必ずレジストリの aiTextProvider() に合わせる。ここで env を直読みすると
  // 未設定時に「生成はOllama、quotaだけGemini前提」というズレが起きて、理由もなく定型文に落ちる。
  if (aiTextProvider() === "ollama") {
    await db
      .update(nagiBotReplyJobs)
      .set({
        generationMode: "ai",
        limitReason: null,
        modeDecidedAt: now,
        updatedAt: now,
      })
      .where(eq(nagiBotReplyJobs.sourceUri, sourceUri));
    return { mode: "ai" };
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${USER_LOCK_KEY}))`,
    );

    const [job] = await tx
      .select({
        generationMode: nagiBotReplyJobs.generationMode,
        limitReason: nagiBotReplyJobs.limitReason,
      })
      .from(nagiBotReplyJobs)
      .where(eq(nagiBotReplyJobs.sourceUri, sourceUri))
      .limit(1);
    if (!job) throw new Error(`Nagi reply job not found: ${sourceUri}`);
    if (job.generationMode) {
      return {
        mode: job.generationMode,
        ...(job.limitReason
          ? { reason: job.limitReason as NagiAiLimitReason }
          : {}),
      };
    }

    const tenMinutesAgo = new Date(now.getTime() - minutes(10));
    const dayAgo = new Date(now.getTime() - hours(24));
    const [counts] = await tx
      .select({
        recent: quotaCountSince(nagiBotReplyJobs.modeDecidedAt, tenMinutesAgo),
        daily: quotaCountSince(nagiBotReplyJobs.modeDecidedAt, dayAgo),
      })
      .from(nagiBotReplyJobs)
      .where(
        and(
          eq(nagiBotReplyJobs.authorDid, authorDid),
          eq(nagiBotReplyJobs.generationMode, "ai"),
        ),
      );
    const reason = userLimitReason(
      countOf(counts?.recent),
      countOf(counts?.daily),
    );
    const mode: NagiReplyMode = reason ? "template" : "ai";

    await tx
      .update(nagiBotReplyJobs)
      .set({
        generationMode: mode,
        limitReason: reason ?? null,
        modeDecidedAt: now,
        updatedAt: now,
      })
      .where(eq(nagiBotReplyJobs.sourceUri, sourceUri));
    return { mode, ...(reason ? { reason } : {}) };
  });

  if (result.reason) logLimit(result.reason, sourceUri);
  return result;
}

export async function switchNagiReplyToTemplate(
  sourceUri: string,
  reason: Extract<NagiAiLimitReason, "service_10m" | "service_24h">,
  now = new Date(),
) {
  await db
    .update(nagiBotReplyJobs)
    .set({
      generationMode: "template",
      limitReason: reason,
      modeDecidedAt: now,
      updatedAt: now,
    })
    .where(eq(nagiBotReplyJobs.sourceUri, sourceUri));
  logLimit(reason, sourceUri);
}

export class NagiAiQuotaExceededError extends Error {
  constructor(
    readonly reason: Extract<NagiAiLimitReason, "service_10m" | "service_24h">,
  ) {
    super(`Nagi AI reply quota exceeded: ${reason}`);
  }
}

export async function reserveNagiAiRequest(now = new Date()): Promise<void> {
  const reason = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${SERVICE_LOCK_KEY}))`,
    );
    await tx
      .delete(nagiAiReplyRequests)
      .where(
        lt(
          nagiAiReplyRequests.requestedAt,
          new Date(now.getTime() - hours(48)),
        ),
      );

    const tenMinutesAgo = new Date(now.getTime() - minutes(10));
    const dayAgo = new Date(now.getTime() - hours(24));
    const [counts] = await tx
      .select({
        recent: quotaCountSince(nagiAiReplyRequests.requestedAt, tenMinutesAgo),
        daily: quotaCountSince(nagiAiReplyRequests.requestedAt, dayAgo),
      })
      .from(nagiAiReplyRequests)
      .where(gte(nagiAiReplyRequests.requestedAt, dayAgo));
    const limited = serviceLimitReason(
      countOf(counts?.recent),
      countOf(counts?.daily),
    );
    if (!limited) {
      await tx.insert(nagiAiReplyRequests).values({ requestedAt: now });
    }
    return limited;
  });

  if (reason) throw new NagiAiQuotaExceededError(reason);
}
