import { and, asc, eq, lt, lte, or } from "drizzle-orm";
import {
  db,
  nagiGuestAffirmationJobs,
} from "@bsky-affirmative-bot/database";
import { createGuestAffirmationReply } from "./guestAffirmationReply.js";
import { startWorkerLoop } from "./workerLoop.js";

const INTERVAL_MS = 2_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
let started = false;

async function run() {
  const now = new Date();
  await db
    .delete(nagiGuestAffirmationJobs)
    .where(lt(nagiGuestAffirmationJobs.expiresAt, now));

  const [job] = await db
    .select()
    .from(nagiGuestAffirmationJobs)
    .where(
      and(
        or(
          eq(nagiGuestAffirmationJobs.state, "pending"),
          eq(nagiGuestAffirmationJobs.state, "processing"),
        ),
        lte(nagiGuestAffirmationJobs.nextAttemptAt, now),
        or(
          eq(nagiGuestAffirmationJobs.state, "pending"),
          lte(nagiGuestAffirmationJobs.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(nagiGuestAffirmationJobs.nextAttemptAt))
    .limit(1);
  if (!job) return;

  const attempt = job.attempts + 1;
  await db
    .update(nagiGuestAffirmationJobs)
    .set({
      state: "processing",
      attempts: attempt,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    })
    .where(eq(nagiGuestAffirmationJobs.id, job.id));

  try {
    const reply = await createGuestAffirmationReply({
      text: job.text,
      language: job.language === "ja" ? "ja" : "en",
    });
    await db
      .update(nagiGuestAffirmationJobs)
      .set({
        state: "posted",
        reply,
        // 端末が受け取るまでだけ保持する。取得後はクライアントが即DELETEする。
        text: "",
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(nagiGuestAffirmationJobs.id, job.id));
  } catch (error) {
    const failed = attempt >= MAX_ATTEMPTS;
    await db
      .update(nagiGuestAffirmationJobs)
      .set({
        state: failed ? "failed" : "pending",
        lastError: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + attempt * 5_000),
        updatedAt: new Date(),
      })
      .where(eq(nagiGuestAffirmationJobs.id, job.id));
    console.warn(JSON.stringify({
      level: "warn",
      event: "guest_affirmation_failed",
      jobId: job.id,
      attempt,
      state: failed ? "failed" : "pending",
    }));
  }
}

export function startGuestAffirmationWorker() {
  if (started) return;
  started = true;
  startWorkerLoop({
    name: "GUEST_AFFIRMATION",
    intervalMs: INTERVAL_MS,
    tick: run,
  }).unref();
}
