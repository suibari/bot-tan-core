import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiZenkatsuCommentJobs } from "@bsky-affirmative-bot/database";
import { runNagiZenkatsu } from "./NagiZenkatsuFeature.js";
import { startWorkerLoop } from "./workerLoop.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 120_000;
/*
 * ユーザーが待っている経路はここを通らない。AppView は提出をコミットした直後に
 * POST /zenkatsu/run を投げ、`processNagiZenkatsuJob(uri)` が直に走る（ジョブ行は
 * コミット済みなのでレースもない）。だから間隔は体感の待ち時間に乗らない。
 *
 * この定期回収が効くのは、通知のHTTPが落ちたとき・処理中のプロセスが落ちて
 * リース（120秒）が切れたとき・失敗のバックオフ（最小10秒）待ちの3つだけ。
 * どれも秒単位を詰める意味がないので、分析ワーカーと同じ間隔に揃える。
 */
const WORKER_INTERVAL_MS = 10_000;
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
  // 直列化するのは定期回収だけ。即時起動（/zenkatsu/run）はユーザーの提出ペースで
  // しか来ないので、ここで弾くと待っている本人の総評が次の tick まで遅れる。
  startWorkerLoop({
    name: "ZENKATSU",
    intervalMs: WORKER_INTERVAL_MS,
    tick: () => processNagiZenkatsuJob(),
  });
}
