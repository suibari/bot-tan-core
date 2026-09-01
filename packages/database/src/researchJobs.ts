import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import { nagiResearchJobs } from "./nagiSchema.js";
import { botMemoryContentHash } from "./botMemory.js";

/**
 * 非同期リサーチのキュー操作。
 *
 * 積まれるのは、返信を書いたモデルが生成と同じ 1 回のリクエストで申告した
 * 「知らなかった語」。判定のための追加 LLM 呼び出しも正規表現も要らない。
 */

export type ResearchJob = {
  subjectHash: string;
  subject: string;
  attempts: number;
};

/** 主キー用の正規化。表記の揺れで同じ語を二重に積まない。 */
export function researchSubjectHash(subject: string): string {
  return botMemoryContentHash(subject.replace(/\s+/g, " ").trim().toLowerCase());
}

/** 積むのは語であって投稿本文ではない。長い文が来たら申告のバグなので切る。 */
const MAX_SUBJECT_LENGTH = 60;
const MIN_SUBJECT_LENGTH = 2;
/**
 * 未処理の上限。
 *
 * ワーカーは同時実行1なので、無制限に積むと滞留して「もう誰も話題にしていない語」を
 * 延々調べ続ける。溢れたぶんは捨てる（次に同じ語が出ればまた積まれる）。
 */
const MAX_PENDING_JOBS = 200;

/**
 * リサーチジョブを積む。同じ語が既にあれば何もしない。
 *
 * 失敗しても呼び出し元（リプライ生成）を巻き込まない。調べられなくても
 * リプライ自体は「知らない」と答えて成立しているため。
 */
export async function enqueueResearchJob(subject: string): Promise<boolean> {
  const trimmed = subject.trim().slice(0, MAX_SUBJECT_LENGTH);
  if (trimmed.length < MIN_SUBJECT_LENGTH) return false;
  try {
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nagiResearchJobs)
      .where(eq(nagiResearchJobs.state, "pending"));
    if ((pending?.count ?? 0) >= MAX_PENDING_JOBS) return false;
    const inserted = await db
      .insert(nagiResearchJobs)
      .values({ subjectHash: researchSubjectHash(trimmed), subject: trimmed })
      .onConflictDoNothing()
      .returning({ subjectHash: nagiResearchJobs.subjectHash });
    return inserted.length > 0;
  } catch (error) {
    console.warn("[WARN][RESEARCH_JOB] enqueue failed", error);
    return false;
  }
}

/** 実行可能なジョブを1件リースする。NagiCardCommentWorker と同じ条件。 */
export async function leaseResearchJob(
  leaseDurationMs: number,
): Promise<ResearchJob | undefined> {
  const now = new Date();
  const rows = await db
    .select()
    .from(nagiResearchJobs)
    .where(
      and(
        or(
          eq(nagiResearchJobs.state, "pending"),
          eq(nagiResearchJobs.state, "processing"),
        ),
        lte(nagiResearchJobs.nextAttemptAt, now),
        or(
          eq(nagiResearchJobs.state, "pending"),
          lte(nagiResearchJobs.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(nagiResearchJobs.nextAttemptAt))
    .limit(1);

  const job = rows[0];
  if (!job) return undefined;

  await db
    .update(nagiResearchJobs)
    .set({
      state: "processing",
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs),
      attempts: job.attempts + 1,
      updatedAt: now,
    })
    .where(eq(nagiResearchJobs.subjectHash, job.subjectHash));

  return { subjectHash: job.subjectHash, subject: job.subject, attempts: job.attempts + 1 };
}

export async function completeResearchJob(subjectHash: string): Promise<void> {
  await db
    .update(nagiResearchJobs)
    .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
    .where(eq(nagiResearchJobs.subjectHash, subjectHash));
}

export async function failResearchJob(input: {
  subjectHash: string;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  error: unknown;
}): Promise<void> {
  await db
    .update(nagiResearchJobs)
    .set({
      state: input.attempts >= input.maxAttempts ? "failed" : "pending",
      lastError:
        input.error instanceof Error ? input.error.message : String(input.error),
      leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + input.backoffMs),
      updatedAt: new Date(),
    })
    .where(eq(nagiResearchJobs.subjectHash, input.subjectHash));
}

/**
 * 完了済みジョブの掃除。
 *
 * 事実は腐るので、調べ直せるように古い成功ジョブごと消す。残したままだと
 * ON CONFLICT DO NOTHING で二度と再調査されない。
 */
export async function pruneResearchJobs(olderThanMs: number): Promise<number> {
  // updated_at は Drizzle 管理下の timestamp 列なので型付き演算子で比較する。
  // raw sql へ Date を直接補間すると postgres.js が文字列を期待して落ちる。
  const cutoff = new Date(Date.now() - olderThanMs);
  const deleted = await db
    .delete(nagiResearchJobs)
    .where(
      and(eq(nagiResearchJobs.state, "posted"), lt(nagiResearchJobs.updatedAt, cutoff)),
    )
    .returning({ subjectHash: nagiResearchJobs.subjectHash });
  return deleted.length;
}
