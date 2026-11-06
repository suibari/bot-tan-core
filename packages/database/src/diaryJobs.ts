import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { diaryDayWindow, dueDiaryDay, shiftDate, type DiaryDayHistory, type DiaryDayWindow } from "@bsky-affirmative-bot/shared-configs";
import { db, diaryJobs, followers, subscribers } from "./db.js";
import { nagiDiaries, nagiPosts } from "./nagiSchema.js";
import { loadDiaryDayHistories, loadDiaryDayHistory } from "./diaryDay.js";

/**
 * 日記を「どの面が書くか」を1か所で決める。決め方はこのファイルだけにあり、
 * nagi_bot_server と bsky_bot_server の両方が同じ関数で決める（先に行を作ったほうが勝つ
 * だけで、結果は同じ）。書くのは、決まった面のサーバーだけ。
 *
 * 1人・1日に diary_jobs の1行しかないので、Nagi と Bluesky の日記が二重にならない。
 * 区切り（タイムゾーンと時刻）は Nagi で本人が教えたものを、Bluesky の日記にも使う。
 */

export type DiarySurface = "nagi" | "bsky";

export type DiaryJob = { did: string; surface: DiarySurface; window: DiaryDayWindow; attempts: number };

const DAY_MS = 24 * 60 * 60 * 1000;
/** 窓が閉じてから決めるまでの猶予。窓の終わり際の投稿が取り込まれるのを待つ。 */
export const DIARY_DECIDE_GRACE_MS = 5 * 60 * 1000;
/** 実行中の期限。生成は最大3時間粘るので、それより長くしておく。 */
export const DIARY_JOB_LEASE_MS = 4 * 60 * 60 * 1000;
/** 失敗した日を試し直す間隔（以前の毎時の再スキャンと同じ）。 */
export const DIARY_JOB_RETRY_MS = 60 * 60 * 1000;
/** Nagi の投稿者を拾う範囲。窓は最長で2日弱（タイムゾーンを大きく西へ動かした日）。 */
const ACTIVE_LOOKBACK_MS = 3 * DAY_MS;

/**
 * 書く面の決め方。その日の窓に Nagi への投稿があれば Nagi。無ければ、Bluesky の日記モードの人
 * （コミュニティメンバー）は Bluesky。Bluesky に投稿があるかは API を呼ばないとわからないので
 * ここでは見ない（Bluesky 側が材料の無い日を skipped にする）。
 */
export function decideDiarySurface(input: {
  hasNagiPosts: boolean;
  blueskyDiary: boolean;
}): DiarySurface | "none" {
  if (input.hasNagiPosts) return "nagi";
  if (input.blueskyDiary) return "bsky";
  return "none";
}

/** 日記の対象になりうる人。Nagi に最近投稿した人と、Bluesky の日記モードの人。 */
async function diaryCandidates(now: Date): Promise<{ dids: string[]; bluesky: Set<string>; legacyDates: Map<string, string> }> {
  const excluded = new Set(
    [process.env.NAGI_BOT_DID, process.env.BSKY_DID].filter(Boolean),
  );
  const developers = (process.env.DEVELOPER_DID ?? "")
    .split(",")
    .map((did) => did.trim())
    .filter(Boolean);
  const [nagiRows, diaryRows, memberRows] = await Promise.all([
    db
      .selectDistinct({ did: nagiPosts.did })
      .from(nagiPosts)
      .where(
        and(
          isNull(nagiPosts.deletedAt),
          gte(nagiPosts.recordCreatedAt, new Date(now.getTime() - ACTIVE_LOOKBACK_MS)),
        ),
      ),
    db.select({ did: followers.did, lastDate: followers.last_diary_date }).from(followers).where(eq(followers.is_diary, 1)),
    db
      .select({ did: subscribers.did })
      .from(subscribers)
      .where(inArray(subscribers.status, ["active", "discord_only"])),
  ]);
  const members = new Set([...memberRows.map((row) => row.did), ...developers]);
  const bluesky = new Set(diaryRows.map((row) => row.did).filter((did) => members.has(did)));
  const dids = [...new Set([...nagiRows.map((row) => row.did), ...bluesky])].filter(
    (did) => !excluded.has(did),
  );
  const legacyDates = new Map(diaryRows.flatMap((row) => row.lastDate ? [[row.did, row.lastDate] as const] : []));
  return { dids, bluesky, legacyDates };
}

/** 夏時間・設定変更・飛んだ日を含め、次の実在する日の終わりを再試行の期限にする。 */
function nextDiaryEnd(window: DiaryDayWindow, history: DiaryDayHistory): Date {
  for (let offset = 1; offset <= 3; offset++) {
    const next = diaryDayWindow(shiftDate(window.date, offset), history);
    if (next.end > window.end) return next.end;
  }
  throw new Error(`No next diary window after ${window.date}`);
}

async function hasNagiPostsIn(did: string, window: DiaryDayWindow): Promise<boolean> {
  const rows = await db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(
      and(
        eq(nagiPosts.did, did),
        isNull(nagiPosts.deletedAt),
        gt(nagiPosts.recordCreatedAt, window.start),
        lte(nagiPosts.recordCreatedAt, window.end),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function hasNagiDiary(did: string, date: string): Promise<boolean> {
  const rows = await db
    .select({ uri: nagiDiaries.uri })
    .from(nagiDiaries)
    .where(and(eq(nagiDiaries.subjectDid, did), eq(nagiDiaries.diaryDate, date)))
    .limit(1);
  return rows.length > 0;
}

/**
 * 窓が閉じた日ごとに、書く面を決めて diary_jobs に1行作る。すでに行があれば何もしない。
 * 両方のサーバーが5分ごとに呼ぶ。作った行の数を返す。
 */
export async function decideDiaryJobs(now: Date = new Date()): Promise<number> {
  // 次の日の窓が閉じても書けなかった日は打ち切る。
  await db
    .update(diaryJobs)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        lte(diaryJobs.expiresAt, now),
        or(
          eq(diaryJobs.status, "pending"),
          and(eq(diaryJobs.status, "running"), lt(diaryJobs.leaseUntil, now)),
        ),
      ),
    );

  const { dids, bluesky, legacyDates } = await diaryCandidates(now);
  if (!dids.length) return 0;
  const histories = await loadDiaryDayHistories(dids);
  const decideAt = new Date(now.getTime() - DIARY_DECIDE_GRACE_MS);
  const due = new Map<string, DiaryDayWindow>();
  for (const did of dids) {
    const window = dueDiaryDay(histories.get(did)!, decideAt);
    if (window) due.set(did, window);
  }
  if (!due.size) return 0;

  const oldest = [...due.values()].reduce((min, w) => (w.date < min ? w.date : min), "9999-12-31");
  const existing = await db
    .select({ did: diaryJobs.did, date: diaryJobs.diaryDate })
    .from(diaryJobs)
    .where(and(inArray(diaryJobs.did, [...due.keys()]), gte(diaryJobs.diaryDate, oldest)));
  const decided = new Set(existing.map((row) => `${row.did}:${row.date}`));

  let created = 0;
  for (const [did, candidate] of due) {
    if (decided.has(`${did}:${candidate.date}`)) continue;
    created += await db.transaction(async (tx) => {
      // 設定保存と同じロック。決定中に区切りが変わって、履歴とジョブの窓がずれるのを防ぐ。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`diary_day:${did}`}))`);
      const history = await loadDiaryDayHistory(did);
      const window = dueDiaryDay(history, decideAt);
      if (!window) return 0;
      // 手動実行（/diaries/run）などで Nagi の日記が先にあれば、Nagi の日として記録する。
      const alreadyNagi = await hasNagiDiary(did, window.date);
      // 移行前に書いた Bluesky の日記も再生成しない。旧列は読むだけで、今後は更新しない。
      const alreadyBsky = legacyDates.get(did) === window.date;
      const hasNagiPosts = alreadyNagi || (await hasNagiPostsIn(did, window));
      const surface = alreadyBsky ? "bsky" : decideDiarySurface({ hasNagiPosts, blueskyDiary: bluesky.has(did) });
      const rows = await tx
        .insert(diaryJobs)
        .values({
          did,
          diaryDate: window.date,
          surface,
          status: alreadyNagi || alreadyBsky ? "done" : surface === "none" ? "skipped" : "pending",
          windowStart: window.start,
          windowEnd: window.end,
          timezone: window.timezone,
          startHour: window.startHour,
          expiresAt: nextDiaryEnd(window, history),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ did: diaryJobs.did });
      if (rows.length && surface !== "none")
        console.log(
          `[INFO][DIARY] job decided: ${did} ${window.date} → ${surface} (tz: ${window.timezone}, cutoff: ${window.startHour}:00)`,
        );
      return rows.length;
    });
  }
  return created;
}

const toJob = (row: typeof diaryJobs.$inferSelect): DiaryJob => ({
  did: row.did,
  surface: row.surface as DiarySurface,
  attempts: row.attempts,
  window: {
    date: row.diaryDate,
    start: row.windowStart,
    end: row.windowEnd,
    timezone: row.timezone,
    startHour: row.startHour,
  },
});

/**
 * 自分の面の、書き待ちの行を取る。取った行は running になり、期限までは他の見回りが取らない。
 * 1つの UPDATE で取るので、同じ行を2か所が同時に取ることはない。
 */
export async function claimDiaryJobs(
  surface: DiarySurface,
  now: Date = new Date(),
): Promise<DiaryJob[]> {
  const rows = await db
    .update(diaryJobs)
    .set({
      status: "running",
      leaseUntil: new Date(now.getTime() + DIARY_JOB_LEASE_MS),
      lastAttemptAt: now,
      attempts: sql`${diaryJobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(diaryJobs.surface, surface),
        gt(diaryJobs.expiresAt, now),
        or(
          and(
            eq(diaryJobs.status, "pending"),
            or(
              isNull(diaryJobs.lastAttemptAt),
              lte(diaryJobs.lastAttemptAt, new Date(now.getTime() - DIARY_JOB_RETRY_MS)),
            ),
          ),
          and(eq(diaryJobs.status, "running"), lt(diaryJobs.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  return rows.map(toJob);
}

export type DiaryJobOutcome = "done" | "skipped" | "failed";

/** 書き終えた（done）、材料が無かった（skipped）、失敗した（failed → 1時間後に試し直す）。 */
export async function finishDiaryJob(
  job: Pick<DiaryJob, "did" | "window" | "attempts">,
  outcome: DiaryJobOutcome,
  note?: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(diaryJobs)
    .set({
      status: outcome === "failed" ? "pending" : outcome,
      leaseUntil: null,
      note: note ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(diaryJobs.did, job.did),
        eq(diaryJobs.diaryDate, job.window.date),
        eq(diaryJobs.status, "running"),
        // リースが切れて別の試行が拾い直したら、前の実行の完了通知で上書きしない。
        eq(diaryJobs.attempts, job.attempts),
      ),
    );
}
