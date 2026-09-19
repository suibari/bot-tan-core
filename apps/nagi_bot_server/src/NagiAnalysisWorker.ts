import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiAnalysisJobs } from "@bsky-affirmative-bot/database";
import { runNagiAnalysis } from "./NagiAnalysisFeature.js";
import { startWorkerLoop } from "./workerLoop.js";

// 分析の機会は「初回登録 / Nagi投稿10件 / 100件ごと」しか無く、失敗すると次の機会まで
// 名刺が出ない。バックオフは 2^attempts * 5s なので 10,20,40,80,160,320,640,1280,2560 秒 =
// 合計およそ85分の窓になる。Gemini の 503 スパイクはこの幅で吸収できる（5回・計310秒では
// 足りず、実際に登録3分後に打ち止めになったユーザーが出た）。
const MAX_ATTEMPTS = 10;
const LEASE_DURATION_MS = 120_000;
// 分析は Gemini + 外部読み出しを伴い頻度も低いので、返信ワーカーより緩めに回す。
const WORKER_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 3_600_000;

let running = false;

/** 自動分析のリースワーカー（NagiReplyWorker と同じ Postgres リースキュー方式）。 */
export function startNagiAnalysisWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const jobs = await db
      .select()
      .from(nagiAnalysisJobs)
      .where(
        and(
          or(
            eq(nagiAnalysisJobs.state, "pending"),
            eq(nagiAnalysisJobs.state, "processing"),
          ),
          lte(nagiAnalysisJobs.nextAttemptAt, now),
          or(
            eq(nagiAnalysisJobs.state, "pending"),
            lte(nagiAnalysisJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(nagiAnalysisJobs.nextAttemptAt))
      .limit(1);

    const job = jobs[0];
    if (!job) return;

    await db
      .update(nagiAnalysisJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(eq(nagiAnalysisJobs.id, job.id));

    try {
      await runNagiAnalysis({
        did: job.did,
        source: job.source,
        postCountAt: job.postCountAt,
      });

      await db
        .update(nagiAnalysisJobs)
        .set({
          state: "posted",
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(nagiAnalysisJobs.id, job.id));
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 5_000);
      await db
        .update(nagiAnalysisJobs)
        .set({
          state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(nagiAnalysisJobs.id, job.id));
    }
  };

  startWorkerLoop({
    name: "NAGI_ANALYSIS",
    intervalMs: WORKER_INTERVAL_MS,
    tick: run,
  });
}
