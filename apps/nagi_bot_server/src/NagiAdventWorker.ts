import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { db, nagiAdventCards, nagiAdventJobs } from "@bsky-affirmative-bot/database";
import {
  adventDueDays,
  adventPublishAt,
  adventYear,
  ADVENT_DAYS,
} from "@bsky-affirmative-bot/shared-configs";
import { runNagiAdvent } from "./NagiAdventFeature.js";
import { notifyAdventCard } from "./appviewInternal.js";
import { startWorkerLoop } from "./workerLoop.js";

const LEASE_DURATION_MS = 600_000;
const WORKER_INTERVAL_MS = 60_000;
/**
 * 再試行の間隔の上限。**失敗で打ち切らない。** カレンダーに空欄を作らないため、
 * 候補が尽きても（その間に新しいポストが増えるので）この間隔で選び直し続ける。
 */
const MAX_BACKOFF_MS = 30 * 60_000;
/** 12/25 の公開からこれだけ過ぎたら、その年はもう何もしない。 */
const SEASON_TAIL_MS = 7 * 24 * 60 * 60_000;

let running = false;

/**
 * アドベントカレンダーの選出ワーカー。
 *
 * ゼンカツ部長賞と同じく、時刻を cron ではなく条件で表す。選出時刻（公開の1時間前）を
 * 過ぎた日のジョブ行を作り、古い日から片付ける。落ちていた間のぶんも起動後に埋まる。
 * 公開時刻を過ぎたカードは、選ばれた本人へ通知する。
 */
export function startNagiAdventWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const year = adventYear(now);
    if (now.getTime() > adventPublishAt(year, ADVENT_DAYS).getTime() + SEASON_TAIL_MS) return;
    const due = adventDueDays(year, now);
    if (!due.length) return;

    await db
      .insert(nagiAdventJobs)
      .values(due.map((day) => ({ year, day })))
      .onConflictDoNothing();

    await notifyPublished(year, now);

    const [job] = await db
      .select()
      .from(nagiAdventJobs)
      .where(
        and(
          eq(nagiAdventJobs.year, year),
          or(eq(nagiAdventJobs.state, "pending"), eq(nagiAdventJobs.state, "processing")),
          lte(nagiAdventJobs.nextAttemptAt, now),
          or(eq(nagiAdventJobs.state, "pending"), lte(nagiAdventJobs.leaseExpiresAt, now)),
        ),
      )
      .orderBy(asc(nagiAdventJobs.day))
      .limit(1);
    if (!job) return;

    const where = and(eq(nagiAdventJobs.year, job.year), eq(nagiAdventJobs.day, job.day));
    await db
      .update(nagiAdventJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(where);

    try {
      await runNagiAdvent(job.year, job.day);
      await db
        .update(nagiAdventJobs)
        .set({ state: "posted", leaseExpiresAt: null, lastError: null, updatedAt: new Date() })
        .where(where);
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 10_000);
      console.error(`[ERROR][NAGI_ADVENT] ${job.year}-12-${job.day} attempt ${attempts}:`, error);
      await db
        .update(nagiAdventJobs)
        .set({
          state: "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(where);
    }
  };

  startWorkerLoop({
    name: "NAGI_ADVENT",
    intervalMs: WORKER_INTERVAL_MS,
    tick: run,
  });
}

/** 公開時刻を過ぎて、まだ知らせていないカードの本人へ通知する。 */
async function notifyPublished(year: number, now: Date) {
  const cards = await db
    .select({ day: nagiAdventCards.day, did: nagiAdventCards.did })
    .from(nagiAdventCards)
    .where(
      and(
        eq(nagiAdventCards.year, year),
        lte(nagiAdventCards.publishAt, now),
        isNull(nagiAdventCards.notifiedAt),
      ),
    );
  for (const card of cards) {
    if (!(await notifyAdventCard(card.did, year, card.day))) continue;
    await db
      .update(nagiAdventCards)
      .set({ notifiedAt: new Date() })
      .where(and(eq(nagiAdventCards.year, year), eq(nagiAdventCards.day, card.day)));
  }
}
