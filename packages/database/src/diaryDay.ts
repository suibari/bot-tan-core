import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  committedDiaryDayHistory,
  diaryDateOf,
  diaryDaySettingFor,
  diaryDayWindow,
  DIARY_DAY_BASELINE_DATE,
  DIARY_DAY_DEFAULT_START_HOUR,
  localeToTimezone,
  nextDiaryDayEffectiveDate,
  sameDiaryDaySetting,
  type DiaryDayHistory,
  type DiaryDayScheduleEntry,
  type DiaryDaySetting,
} from "@bsky-affirmative-bot/shared-configs";
import { db, diaryJobs, followers } from "./db.js";
import {
  nagiDiaries,
  nagiDiaryDayPreferences,
  nagiDiaryDaySchedules,
  nagiPosts,
} from "./nagiSchema.js";

/**
 * 日記の「1日」の設定を読み書きする。区切りの計算そのものは shared-configs の diaryDay.ts。
 * AppView（日付の割り当て）と nagi_bot_server（日記の生成）は、どちらもここで履歴を読む。
 */

const firstLang = (langs: unknown) => (Array.isArray(langs) ? (langs[0] as unknown) : undefined);
const zoneOfLang = (lang: unknown) =>
  typeof lang === "string" && lang ? localeToTimezone[lang] : undefined;

/**
 * 設定が無い人のタイムゾーンの推定。上から順に、最初に決まったものを使う。
 *  1. 最新の Nagi の日記の言語（以前の AppView の loadMoodTimezone と同じ）
 *  2. 最新の Nagi への投稿の言語
 *  3. Bluesky の最新の投稿の言語（Nagi を使っていない人。bsky_bot_server が記録する）
 *  4. UTC
 */
export async function guessDiaryTimezones(dids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!dids.length) return result;
  const [diaries, posts, bsky] = await Promise.all([
    db
      .selectDistinctOn([nagiDiaries.subjectDid], {
        did: nagiDiaries.subjectDid,
        langs: nagiDiaries.langs,
      })
      .from(nagiDiaries)
      .where(inArray(nagiDiaries.subjectDid, dids))
      .orderBy(nagiDiaries.subjectDid, desc(nagiDiaries.diaryDate)),
    db
      .selectDistinctOn([nagiPosts.did], { did: nagiPosts.did, langs: nagiPosts.langs })
      .from(nagiPosts)
      .where(and(inArray(nagiPosts.did, dids), isNull(nagiPosts.deletedAt)))
      .orderBy(nagiPosts.did, desc(nagiPosts.recordCreatedAt)),
    db
      .select({ did: followers.did, lang: followers.diary_bsky_lang })
      .from(followers)
      .where(inArray(followers.did, dids)),
  ]);
  const byDid = (rows: { did: string; zone: string | undefined }[]) =>
    new Map(rows.flatMap((row) => (row.zone ? [[row.did, row.zone] as const] : [])));
  const fromDiary = byDid(diaries.map((row) => ({ did: row.did, zone: zoneOfLang(firstLang(row.langs)) })));
  const fromPost = byDid(posts.map((row) => ({ did: row.did, zone: zoneOfLang(firstLang(row.langs)) })));
  const fromBsky = byDid(bsky.map((row) => ({ did: row.did, zone: zoneOfLang(row.lang) })));
  for (const did of dids)
    result.set(did, fromDiary.get(did) ?? fromPost.get(did) ?? fromBsky.get(did) ?? "UTC");
  return result;
}

export async function guessDiaryTimezone(did: string): Promise<string> {
  return (await guessDiaryTimezones([did])).get(did) ?? "UTC";
}

const toEntry = (row: typeof nagiDiaryDaySchedules.$inferSelect): DiaryDayScheduleEntry => ({
  effectiveFrom: row.effectiveFrom,
  timezone: row.timezone,
  startHour: row.startHour,
});

/** 何人分かの履歴（予約中の行も含む）。行が無い人は Map に入らない。 */
async function selectHistories(dids: string[]): Promise<Map<string, DiaryDayScheduleEntry[]>> {
  const result = new Map<string, DiaryDayScheduleEntry[]>();
  if (!dids.length) return result;
  const rows = await db
    .select()
    .from(nagiDiaryDaySchedules)
    .where(inArray(nagiDiaryDaySchedules.did, dids))
    .orderBy(nagiDiaryDaySchedules.did, nagiDiaryDaySchedules.effectiveFrom);
  for (const row of rows) {
    const list = result.get(row.did);
    if (list) list.push(toEntry(row));
    else result.set(row.did, [toEntry(row)]);
  }
  return result;
}

const fallbackHistory = (timezone: string): DiaryDayHistory => [
  {
    effectiveFrom: DIARY_DAY_BASELINE_DATE,
    timezone,
    startHour: DIARY_DAY_DEFAULT_START_HOUR,
  },
];

/** 区切りに使う履歴。行が無ければ推定（guessDiaryTimezones）と22時の1行だけ。 */
export async function loadDiaryDayHistory(did: string): Promise<DiaryDayHistory> {
  const rows = (await selectHistories([did])).get(did);
  return rows?.length ? rows : fallbackHistory(await guessDiaryTimezone(did));
}

/** 複数人の履歴をまとめて読む（日記のスケジューラ用）。 */
export async function loadDiaryDayHistories(dids: string[]): Promise<Map<string, DiaryDayHistory>> {
  const rows = await selectHistories(dids);
  const guesses = await guessDiaryTimezones(dids.filter((did) => !rows.get(did)?.length));
  const result = new Map<string, DiaryDayHistory>();
  for (const did of dids) {
    const list = rows.get(did);
    result.set(did, list?.length ? list : fallbackHistory(guesses.get(did) ?? "UTC"));
  }
  return result;
}

export type DiaryDayPreferencesInput = {
  /** ブラウザが検出したタイムゾーン。呼び出し側で isUsableDetectedTimezone を通しておく。 */
  detectedTimezone?: string;
  /** 手動のタイムゾーン。null で自動に戻す。 */
  manualTimezone?: string | null;
  /** 区切りの時刻。null で既定（22時）に戻す。 */
  startHour?: number | null;
};

export type DiaryDayPreferencesState = {
  detectedTimezone?: string;
  manualTimezone?: string;
  /** 本人が選んだ区切り（未設定なら22）。 */
  startHour: number;
  /**
   * 今開いている日に使っている設定。effectiveFrom はその設定が有効になった日
   * （言語からの推定のままなら省略）。
   */
  current: DiaryDaySetting & { effectiveFrom?: string };
  /** まだ有効になっていない変更。 */
  pending?: DiaryDaySetting & { effectiveFrom: string };
};

async function lastDiaryDate(did: string, reader: Pick<typeof db, "select"> = db): Promise<string | undefined> {
  // 書き先を決めた日は窓を凍結する。Bluesky へ書いた日や実行待ちの日も動かさない。
  const [diaries, jobs, legacy] = await Promise.all([
    reader.select({ date: nagiDiaries.diaryDate }).from(nagiDiaries)
      .where(eq(nagiDiaries.subjectDid, did)).orderBy(desc(nagiDiaries.diaryDate)).limit(1),
    reader.select({ date: diaryJobs.diaryDate }).from(diaryJobs)
      .where(eq(diaryJobs.did, did)).orderBy(desc(diaryJobs.diaryDate)).limit(1),
    reader.select({ date: followers.last_diary_date }).from(followers)
      .where(eq(followers.did, did)).limit(1),
  ]);
  return [...diaries, ...jobs, ...legacy].flatMap((row) => row.date ? [row.date] : []).sort().at(-1);
}

function stateOf(
  prefs: typeof nagiDiaryDayPreferences.$inferSelect | undefined,
  history: DiaryDayHistory,
  now: Date,
): DiaryDayPreferencesState {
  const committed = committedDiaryDayHistory(history, now);
  const open = diaryDateOf(now, committed);
  const pending = history.find((entry) => entry.effectiveFrom > open);
  const since = [...committed].reverse().find((entry) => entry.effectiveFrom <= open);
  return {
    ...(prefs?.detectedTimezone ? { detectedTimezone: prefs.detectedTimezone } : {}),
    ...(prefs?.manualTimezone ? { manualTimezone: prefs.manualTimezone } : {}),
    startHour: prefs?.startHour ?? DIARY_DAY_DEFAULT_START_HOUR,
    current: {
      ...diaryDaySettingFor(open, committed),
      ...(since && since.effectiveFrom !== DIARY_DAY_BASELINE_DATE
        ? { effectiveFrom: since.effectiveFrom }
        : {}),
    },
    ...(pending ? { pending: { ...pending } } : {}),
  };
}

export async function getDiaryDayPreferences(
  did: string,
  now: Date = new Date(),
): Promise<DiaryDayPreferencesState> {
  const [[prefs], history] = await Promise.all([
    db.select().from(nagiDiaryDayPreferences).where(eq(nagiDiaryDayPreferences.did, did)).limit(1),
    loadDiaryDayHistory(did),
  ]);
  return stateOf(prefs, history, now);
}

/**
 * 本人の入力を保存し、区切りが変わるなら履歴に「いつから」を付けて足す。
 * - 今開いている日より後の予約は、新しい変更で置き換える（元に戻したなら予約を消すだけ）。
 * - 初めて履歴を書く人は、それまでの推定（言語＋22時）を baseline として凍結する。
 *   こうしておくと、あとで言語が変わっても過去の日が動かない。
 */
export async function putDiaryDayPreferences(
  did: string,
  input: DiaryDayPreferencesInput,
  now: Date = new Date(),
): Promise<DiaryDayPreferencesState> {
  const guessed = await guessDiaryTimezone(did);
  return db.transaction(async (tx) => {
    // 同じ人の同時保存（複数端末から同時に開いたなど）を直列にする。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`diary_day:${did}`}))`);
    const lastDate = await lastDiaryDate(did, tx);

    const [before] = await tx
      .select()
      .from(nagiDiaryDayPreferences)
      .where(eq(nagiDiaryDayPreferences.did, did))
      .limit(1);
    const values = {
      detectedTimezone:
        input.detectedTimezone !== undefined ? input.detectedTimezone : (before?.detectedTimezone ?? null),
      detectedAt: input.detectedTimezone !== undefined ? now : (before?.detectedAt ?? null),
      manualTimezone:
        input.manualTimezone !== undefined ? input.manualTimezone : (before?.manualTimezone ?? null),
      startHour: input.startHour !== undefined ? input.startHour : (before?.startHour ?? null),
      updatedAt: now,
    };
    const [prefs] = await tx
      .insert(nagiDiaryDayPreferences)
      .values({ did, ...values })
      .onConflictDoUpdate({ target: nagiDiaryDayPreferences.did, set: values })
      .returning();

    const rows = (
      await tx
        .select()
        .from(nagiDiaryDaySchedules)
        .where(eq(nagiDiaryDaySchedules.did, did))
        .orderBy(nagiDiaryDaySchedules.effectiveFrom)
    ).map(toEntry);
    const history: DiaryDayScheduleEntry[] = rows.length
      ? rows
      : [...fallbackHistory(guessed)];
    if (!rows.length)
      await tx.insert(nagiDiaryDaySchedules).values({
        did,
        ...history[0],
        source: "baseline",
      });

    const committed = committedDiaryDayHistory(history, now);
    const open = diaryDateOf(now, committed);
    const next: DiaryDaySetting = {
      timezone: prefs.manualTimezone ?? prefs.detectedTimezone ?? committed[0].timezone,
      startHour: prefs.startHour ?? DIARY_DAY_DEFAULT_START_HOUR,
    };
    const source = prefs.manualTimezone ? "manual" : prefs.detectedTimezone ? "auto" : "guess";

    // 予約は置き換える。
    await tx
      .delete(nagiDiaryDaySchedules)
      .where(and(eq(nagiDiaryDaySchedules.did, did), gt(nagiDiaryDaySchedules.effectiveFrom, open)));

    let result: DiaryDayHistory = committed;
    if (!sameDiaryDaySetting(diaryDaySettingFor(open, committed), next)) {
      const effectiveFrom = nextDiaryDayEffectiveDate(committed, next, now, lastDate);
      const without = committed.filter((entry) => entry.effectiveFrom !== effectiveFrom);
      if (sameDiaryDaySetting(diaryDaySettingFor(effectiveFrom, without), next)) {
        // 同じ日に変えてから元に戻した。その日の行を消せば、前の設定がそのまま続く。
        await tx
          .delete(nagiDiaryDaySchedules)
          .where(
            and(
              eq(nagiDiaryDaySchedules.did, did),
              eq(nagiDiaryDaySchedules.effectiveFrom, effectiveFrom),
            ),
          );
        result = without;
      } else {
        await tx
          .insert(nagiDiaryDaySchedules)
          .values({ did, effectiveFrom, ...next, source })
          .onConflictDoUpdate({
            target: [nagiDiaryDaySchedules.did, nagiDiaryDaySchedules.effectiveFrom],
            set: { timezone: next.timezone, startHour: next.startHour, source, createdAt: now },
          });
        result = [...without, { effectiveFrom, ...next }].sort((a, b) =>
          a.effectiveFrom.localeCompare(b.effectiveFrom),
        );
      }
    }
    // 翌日の区切りが動けば、すでに決めた日の再試行期限も同じ終わりに合わせる。
    const retrying = await tx.select().from(diaryJobs).where(
      and(eq(diaryJobs.did, did), inArray(diaryJobs.status, ["pending", "running"])),
    );
    for (const job of retrying) {
      const nextDate = diaryDateOf(new Date(job.windowEnd.getTime() + 1), result);
      await tx.update(diaryJobs).set({ expiresAt: diaryDayWindow(nextDate, result).end })
        .where(and(eq(diaryJobs.did, did), eq(diaryJobs.diaryDate, job.diaryDate)));
    }
    return stateOf(prefs, result, now);
  });
}
