import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import { bot_memory_research_jobs } from "./schema.js";
import { botMemoryContentHash } from "./botMemory.js";

/**
 * 非同期リサーチのキュー操作。
 *
 * 積まれるのは「botたんが遭遇してまだ知らない語」。返信を書いたモデルが生成と同じ
 * 1 回のリクエストで申告したものと、記憶から抽出された印象ラベル（YouTube 配信の
 * コメント由来を含む）。
 *
 * 判定のための追加 LLM 呼び出しも正規表現も要らない。処理するのは biorhythm_server の
 * botMemoryResearchWorker で、出口は全サーフェス共通の bot_memory_documents。
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

/**
 * 積むのは語であって投稿本文ではない。長い文が来たら申告のバグなので切る。
 *
 * URL はここへ積まない。貼られたリンクはその場で答えたいので、リプライ生成の前に
 * 同期で読む（grounding.ts）。非同期に回すと「次に同じリンクが来たら答えられる」に
 * なってしまい、実際の会話では役に立たない。
 */
const MAX_TERM_LENGTH = 60;
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
  const trimmed = subject.trim().slice(0, MAX_TERM_LENGTH);
  if (trimmed.length < MIN_SUBJECT_LENGTH) return false;
  try {
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bot_memory_research_jobs)
      .where(eq(bot_memory_research_jobs.state, "pending"));
    if ((pending?.count ?? 0) >= MAX_PENDING_JOBS) return false;
    const inserted = await db
      .insert(bot_memory_research_jobs)
      .values({ subject_hash: researchSubjectHash(trimmed), subject: trimmed })
      .onConflictDoNothing()
      .returning({ subjectHash: bot_memory_research_jobs.subject_hash });
    return inserted.length > 0;
  } catch (error) {
    console.warn("[WARN][RESEARCH_JOB] enqueue failed", error);
    return false;
  }
}

/** 実行可能なジョブを1件リースする。既存のリースキュー各種と同じ条件。 */
export async function leaseResearchJob(
  leaseDurationMs: number,
): Promise<ResearchJob | undefined> {
  const now = new Date();
  const rows = await db
    .select()
    .from(bot_memory_research_jobs)
    .where(
      and(
        or(
          eq(bot_memory_research_jobs.state, "pending"),
          eq(bot_memory_research_jobs.state, "processing"),
        ),
        lte(bot_memory_research_jobs.next_attempt_at, now),
        or(
          eq(bot_memory_research_jobs.state, "pending"),
          lte(bot_memory_research_jobs.lease_expires_at, now),
        ),
      ),
    )
    .orderBy(asc(bot_memory_research_jobs.next_attempt_at))
    .limit(1);

  const job = rows[0];
  if (!job) return undefined;

  await db
    .update(bot_memory_research_jobs)
    .set({
      state: "processing",
      lease_expires_at: new Date(Date.now() + leaseDurationMs),
      attempts: job.attempts + 1,
      updated_at: now,
    })
    .where(eq(bot_memory_research_jobs.subject_hash, job.subject_hash));

  return { subjectHash: job.subject_hash, subject: job.subject, attempts: job.attempts + 1 };
}

export async function completeResearchJob(subjectHash: string): Promise<void> {
  await db
    .update(bot_memory_research_jobs)
    .set({ state: "posted", lease_expires_at: null, updated_at: new Date() })
    .where(eq(bot_memory_research_jobs.subject_hash, subjectHash));
}

export async function failResearchJob(input: {
  subjectHash: string;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  error: unknown;
}): Promise<void> {
  await db
    .update(bot_memory_research_jobs)
    .set({
      state: input.attempts >= input.maxAttempts ? "failed" : "pending",
      last_error:
        input.error instanceof Error ? input.error.message : String(input.error),
      lease_expires_at: null,
      next_attempt_at: new Date(Date.now() + input.backoffMs),
      updated_at: new Date(),
    })
    .where(eq(bot_memory_research_jobs.subject_hash, input.subjectHash));
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
    .delete(bot_memory_research_jobs)
    .where(
      and(eq(bot_memory_research_jobs.state, "posted"), lt(bot_memory_research_jobs.updated_at, cutoff)),
    )
    .returning({ subjectHash: bot_memory_research_jobs.subject_hash });
  return deleted.length;
}
