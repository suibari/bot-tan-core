import { and, asc, eq, lt, lte, or } from "drizzle-orm";
import { db, nagiZenkatsuAwardJobs } from "@bsky-affirmative-bot/database";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import { runNagiZenkatsuAward } from "./NagiZenkatsuAwardFeature.js";
import { startWorkerLoop } from "./workerLoop.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 300_000;
// 1日1回しか実際の仕事が無いので、短く回す必要が無い。
const WORKER_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 900_000;

let running = false;

/**
 * ゼンカツ！の部長賞確定ワーカー。
 *
 * **JST 4:00 の発火を cron ではなく条件で表現する。** ジョブ行はその日の最初の提出で作られ、
 * 「theme_date がもう今日ではない」＝その日が閉じた、という条件でだけ処理する。
 * 日付境界の判定は cardDrawDate（JST 4:00 始まり）に一本化されるので、
 * サーバのタイムゾーン設定にも、ワーカーの起動時刻にも依存しない。
 * 落ちていた間のぶんも、起動後に古い順から自然に片付く。
 */
export function startNagiZenkatsuAwardWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const today = cardDrawDate(now);
    const jobs = await db
      .select()
      .from(nagiZenkatsuAwardJobs)
      .where(
        and(
          // その日が閉じるまでは確定しない。ここが「JST 4:00 に切り替わる」の実体。
          lt(nagiZenkatsuAwardJobs.themeDate, today),
          or(
            eq(nagiZenkatsuAwardJobs.state, "pending"),
            eq(nagiZenkatsuAwardJobs.state, "processing"),
          ),
          lte(nagiZenkatsuAwardJobs.nextAttemptAt, now),
          or(
            eq(nagiZenkatsuAwardJobs.state, "pending"),
            lte(nagiZenkatsuAwardJobs.leaseExpiresAt, now),
          ),
        ),
      )
      // 溜まっている場合は古い日から。記録が日付順に埋まるようにする。
      .orderBy(asc(nagiZenkatsuAwardJobs.themeDate))
      .limit(1);

    const job = jobs[0];
    if (!job) return;

    await db
      .update(nagiZenkatsuAwardJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(eq(nagiZenkatsuAwardJobs.themeDate, job.themeDate));

    try {
      await runNagiZenkatsuAward(job.themeDate);
      await db
        .update(nagiZenkatsuAwardJobs)
        .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
        .where(eq(nagiZenkatsuAwardJobs.themeDate, job.themeDate));
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 10_000);
      // 上限まで失敗しても、その日の記録と即時の賞は残る。部長賞が付かないだけ。
      await db
        .update(nagiZenkatsuAwardJobs)
        .set({
          state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(nagiZenkatsuAwardJobs.themeDate, job.themeDate));
    }
  };

  startWorkerLoop({
    name: "ZENKATSU_AWARD",
    intervalMs: WORKER_INTERVAL_MS,
    tick: run,
  });
}
