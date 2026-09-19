import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiZenkatsuCommentJobs } from "@bsky-affirmative-bot/database";
import { runNagiZenkatsu } from "./NagiZenkatsuFeature.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 120_000;
/*
 * ユーザーは提出直後、総評が出るまで画面で待っている。
 *
 * 生成そのものは実測 3.2秒。そこへ取得待ちが丸ごと上乗せされるので、間隔がそのまま
 * 体感の待ち時間になる（3秒間隔だと最悪 3.2 + 3.0 秒）。空振りのクエリは
 * (state, next_attempt_at) の索引で引く軽いものなので、短くしても負荷はほぼ増えない。
 */
const WORKER_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

let running = false;

interface ZenkatsuJobDependencies {
  db: typeof db;
  generate: typeof runNagiZenkatsu;
}

/** 提出直後の起動と、取りこぼしの定期回収で同じリースを使う。 */
export async function processNagiZenkatsuJob(
  submissionUri?: string,
  dependencies: ZenkatsuJobDependencies = { db, generate: runNagiZenkatsu },
) {
  const { db, generate } = dependencies;
  const now = new Date();
  const jobs = await db
    .select()
    .from(nagiZenkatsuCommentJobs)
    .where(
      and(
        submissionUri ? eq(nagiZenkatsuCommentJobs.submissionUri, submissionUri) : undefined,
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

  const claimed = await db
    .update(nagiZenkatsuCommentJobs)
    .set({
      state: "processing",
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      attempts: job.attempts + 1,
      updatedAt: now,
    })
    .where(and(
      eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri),
      eq(nagiZenkatsuCommentJobs.attempts, job.attempts),
      eq(nagiZenkatsuCommentJobs.state, job.state),
      lte(nagiZenkatsuCommentJobs.nextAttemptAt, now),
      or(
        eq(nagiZenkatsuCommentJobs.state, "pending"),
        lte(nagiZenkatsuCommentJobs.leaseExpiresAt, now),
      ),
    ))
    .returning({ uri: nagiZenkatsuCommentJobs.submissionUri });
  // 即時起動・定期回収・別プロセスが競合しても、取得できた一つだけが生成する。
  if (!claimed.length) return;

  try {
    await generate(job.submissionUri);

    await db
      .update(nagiZenkatsuCommentJobs)
      .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(
        eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri),
        eq(nagiZenkatsuCommentJobs.state, "processing"),
        eq(nagiZenkatsuCommentJobs.attempts, job.attempts + 1),
      ));
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
      .where(and(
        eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri),
        eq(nagiZenkatsuCommentJobs.state, "processing"),
        eq(nagiZenkatsuCommentJobs.attempts, job.attempts + 1),
      ));
  }
}

export function startNagiZenkatsuWorker() {
  if (running) return;
  running = true;
  setInterval(() => {
    void processNagiZenkatsuJob().catch(console.error);
  }, WORKER_INTERVAL_MS);
}
