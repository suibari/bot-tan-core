import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiZenkatsuCommentJobs } from "@bsky-affirmative-bot/database";
import { runNagiZenkatsu } from "./NagiZenkatsuFeature.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 120_000;
// ユーザーは提出直後に総評を見に来るので、分析ワーカーより短い間隔で回す。
const WORKER_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 300_000;

let running = false;

/**
 * ゼンカツ！の総評生成ワーカー（NagiCardCommentWorker と同型のリースキュー方式）。
 * エンキューは AppView が提出レコードを索引した時点で行う。
 */
export function startNagiZenkatsuWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const jobs = await db
      .select()
      .from(nagiZenkatsuCommentJobs)
      .where(
        and(
          or(
            eq(nagiZenkatsuCommentJobs.state, "pending"),
            eq(nagiZenkatsuCommentJobs.state, "processing"),
          ),
          lte(nagiZenkatsuCommentJobs.nextAttemptAt, now),
          or(
            eq(nagiZenkatsuCommentJobs.state, "pending"),
            lte(nagiZenkatsuCommentJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(nagiZenkatsuCommentJobs.nextAttemptAt))
      .limit(1);

    const job = jobs[0];
    if (!job) return;

    await db
      .update(nagiZenkatsuCommentJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri));

    try {
      await runNagiZenkatsu(job.submissionUri);

      await db
        .update(nagiZenkatsuCommentJobs)
        .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
        .where(eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri));
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 5_000);
      // 上限まで失敗しても提出そのものは記録に残っている。comment が NULL のままになるだけで、
      // UI はコメント無しで普通に表示する（提出できなかったことにはしない）。
      await db
        .update(nagiZenkatsuCommentJobs)
        .set({
          state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri));
    }
  };

  setInterval(() => {
    void run().catch(console.error);
  }, WORKER_INTERVAL_MS);
}
