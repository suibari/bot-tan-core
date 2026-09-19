import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiCardCommentJobs } from "@bsky-affirmative-bot/database";
import { runNagiCardComment } from "./NagiCardCommentFeature.js";
import { startWorkerLoop } from "./workerLoop.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 120_000;
// ユーザーはドロー演出を見ながらコメントを待っているので、分析ワーカーより短い間隔で回す。
const WORKER_INTERVAL_MS = 3_000;
const MAX_BACKOFF_MS = 300_000;

let running = false;

/**
 * 全肯定カードの botたんコメント生成ワーカー（NagiAnalysisWorker と同じリースキュー方式）。
 * エンキューは AppView の drawCard が担う。
 */
export function startNagiCardCommentWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const jobs = await db
      .select()
      .from(nagiCardCommentJobs)
      .where(
        and(
          or(
            eq(nagiCardCommentJobs.state, "pending"),
            eq(nagiCardCommentJobs.state, "processing"),
          ),
          lte(nagiCardCommentJobs.nextAttemptAt, now),
          or(
            eq(nagiCardCommentJobs.state, "pending"),
            lte(nagiCardCommentJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(nagiCardCommentJobs.nextAttemptAt))
      .limit(1);

    const job = jobs[0];
    if (!job) return;

    await db
      .update(nagiCardCommentJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(eq(nagiCardCommentJobs.instanceId, job.instanceId));

    try {
      await runNagiCardComment(job.instanceId);

      await db
        .update(nagiCardCommentJobs)
        .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
        .where(eq(nagiCardCommentJobs.instanceId, job.instanceId));
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 5_000);
      // 上限まで失敗してもカード自体は既に手元にある。comment が NULL のままになるだけで、
      // UI はコメント無しで普通に表示する（引けなかったことにはしない）。
      await db
        .update(nagiCardCommentJobs)
        .set({
          state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(nagiCardCommentJobs.instanceId, job.instanceId));
    }
  };

  startWorkerLoop({
    name: "NAGI_CARD_COMMENT",
    intervalMs: WORKER_INTERVAL_MS,
    tick: run,
  });
}
