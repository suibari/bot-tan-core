import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import { nagiResearchJobs } from "./nagiSchema.js";
import { botMemoryContentHash } from "./botMemory.js";

/**
 * 非同期リサーチのキュー操作。
 *
 * リプライの同期パスからは検索を外したので、調べる仕事はここに積まれて
 * NagiResearchWorker が拾う。積む側（リプライ生成の直後）は LLM を呼ばず、
 * 正規表現の判定だけで済ませる＝同期パスのコストをゼロにするのが要件。
 */

export type ResearchJob = {
  subjectHash: string;
  subject: string;
  attempts: number;
};

/** 主キー用の正規化。空白と大小文字の揺れで同じ話題を二重に積まない。 */
export function researchSubjectHash(subject: string): string {
  return botMemoryContentHash(subject.replace(/\s+/g, " ").trim().toLowerCase());
}

const MAX_SUBJECT_LENGTH = 4_000;

/**
 * リサーチジョブを積む。同じ話題が既にあれば何もしない。
 *
 * 失敗しても呼び出し元（リプライ生成）を巻き込まない。調べられなくても
 * リプライ自体は「知らない」と答えて成立しているため。
 */
export async function enqueueResearchJob(subject: string): Promise<boolean> {
  const trimmed = subject.trim().slice(0, MAX_SUBJECT_LENGTH);
  if (!trimmed) return false;
  try {
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
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const deleted = await db
    .delete(nagiResearchJobs)
    .where(
      and(
        eq(nagiResearchJobs.state, "posted"),
        // Drizzle 管理下の列なので型付き演算子で比較したいところだが、ここは
        // 明示キャストで揃える（Date をそのまま raw SQL へ渡さない）。
        sql`${nagiResearchJobs.updatedAt} < ${cutoff}::timestamptz`,
      ),
    )
    .returning({ subjectHash: nagiResearchJobs.subjectHash });
  return deleted.length;
}
