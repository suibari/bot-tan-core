import { and, eq } from "drizzle-orm";
import {
  claimDiaryJobs,
  db,
  decideDiaryJobs,
  finishDiaryJob,
  loadDiaryDayHistory,
  type DiaryJob,
  type DiaryJobOutcome,
  MemoryService,
  nagiActors,
  nagiDiaries,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  applyDiaryTitle,
  buildUserDiaryContext,
  getLangStr,
  trackedDeleteRecord,
  withPreferredName,
  selectUserDiaryMediaReference,
} from "@bsky-affirmative-bot/clients";
import {
  diaryDateOf,
  diaryDayWindow,
  isEmptyDiaryDay,
  isInDiaryDayWindow,
  type DiaryDayWindow,
} from "@bsky-affirmative-bot/shared-configs";
import {
  DIARY_MAX_ATTEMPTS,
  generateUserDiaryResilient,
  type DiaryResult,
  type UserDiaryDayContext,
} from "@bsky-affirmative-bot/bot-brain";
import type { AppBskyActorDefs } from "@atproto/api";
import { NAGI, type NagiDiary } from "@bsky-affirmative-bot/nagi-lexicon";
import retry from "async-retry";
import { agent } from "./agent.js";
import { createDiary } from "./appviewInternal.js";
import { clipNagiPostText } from "./nagiPostText.js";
import { startWorkerLoop } from "./workerLoop.js";

/**
 * 見回りの間隔。区切りの時刻は人ごとに違い、30分・45分ずれのタイムゾーンもあるので、
 * 人ごとの setTimeout ではなく短い間隔で見回る。どの面（Nagi / Bluesky）が書くかは
 * database の decideDiaryJobs が決め、ここでは Nagi の行だけを取って書く。
 * 窓の終わりは計算で決まるので、見回りが遅れても日記の材料は変わらない。
 */
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 日記レコードの rkey。
 * DID の ":" は rkey に使えないので "_" にする。(subject, date) で一意なので
 * putRecord を何度呼んでも増えない。
 */
function diaryRkey(subject: string, date: string): string {
  return `${subject.replaceAll(":", "_")}-${date}`;
}

async function loadDiaryDayContext(
  did: string,
  date: string,
  since: Date,
  until: Date,
  timezone: string,
  japanese: boolean,
): Promise<UserDiaryDayContext> {
  return buildUserDiaryContext({
    did,
    date,
    since,
    until,
    timezone,
    japanese,
  });
}

async function getDisplayName(did: string): Promise<string> {
  const [[profile], [actor]] = await Promise.all([
    db
      .select({ displayName: nagiProfiles.displayName })
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, did))
      .limit(1),
    db
      .select({ handle: nagiActors.handle })
      .from(nagiActors)
      .where(eq(nagiActors.did, did))
      .limit(1),
  ]);
  return profile?.displayName || actor?.handle || did;
}

/**
 * 1ユーザー分の日記を書く。
 * ポストではなく com.suibari.nagi.diary レコードを AppView にだけ作るので、
 * グローバルタイムラインには出ない。日記は本人だけが読むもので、PDS には書かない。
 * 通知は AppView が取り込み時に作る。
 *
 * window は shared-configs の diaryDayWindow で求めた、その日の窓（AppView の日付の
 * 割り当てと同じ決め方）。省略すると今開いている日を、今この瞬間までの材料で書く
 * （手動の /diaries/run 用）。どちらでも (subject, date) の存在チェックが二重生成を防ぐ。
 */
export async function processNagiDiary(
  userDid: string,
  window?: DiaryDayWindow,
): Promise<DiaryJobOutcome> {
  try {
    console.log(`[INFO][NAGI][${userDid}] Processing diary...`);

    let day = window;
    if (!day) {
      const now = new Date();
      const history = await loadDiaryDayHistory(userDid);
      const open = diaryDayWindow(diaryDateOf(now, history), history);
      day = { ...open, end: now };
    }
    if (isEmptyDiaryDay(day)) {
      console.log(`[INFO][NAGI][${userDid}] ${day.date} is an empty day, skipping`);
      return "skipped";
    }
    const { date, timezone } = day;
    const since = day.start;
    const until = day.end;
    // getNagiPostsSince は下限しか持たないので、窓の両端はここで切る。
    const recentPosts = (await MemoryService.getNagiPostsSince(userDid, since)).filter(
      (post) => post.recordCreatedAt && isInDiaryDayWindow(post.recordCreatedAt, day),
    );
    if (recentPosts.length === 0) {
      console.log(`[INFO][NAGI][${userDid}] today's post not found`);
      return "skipped";
    }

    // こっそりを1つでも含む日かどうか。日記はどれも本人限定なので出し分けには使わず、記録として残す。
    const isPrivate = recentPosts.some((post) => post.kossori);

    const latestLangs = [...recentPosts]
      .reverse()
      .find((post) => Array.isArray(post.langs) && post.langs.length)?.langs as
      | string[]
      | undefined;
    const langStr = getLangStr(latestLangs);

    const existing = await db
      .select({ uri: nagiDiaries.uri })
      .from(nagiDiaries)
      .where(
        and(
          eq(nagiDiaries.subjectDid, userDid),
          eq(nagiDiaries.diaryDate, date),
        ),
      )
      .limit(1);
    if (existing[0]) {
      console.log(`[INFO][NAGI][${userDid}] diary for ${date} already exists`);
      return "done";
    }

    const dayContext = await loadDiaryDayContext(
      userDid,
      date,
      since,
      until,
      timezone,
      langStr === "日本語",
    );
    const mediaReference = await selectUserDiaryMediaReference(userDid, date);

    const displayName = await getDisplayName(userDid);
    // generateUserDiary が見るのは displayName だけだが、型は Bluesky の ProfileView。
    const follower: AppBskyActorDefs.ProfileView = {
      did: userDid,
      handle: displayName,
      displayName,
    };

    console.log(`[INFO][NAGI][${userDid}] generating diary...`);
    let diaryResult: DiaryResult;
    try {
      // 失敗するたびにモデル/tier を上げながら最大3時間粘る。
      // 使い切っても、次の日の窓が閉じるまでは diary_jobs を1時間おきに拾い直す。
      const userinfo = await withPreferredName({
        follower,
        posts: recentPosts.map((post) => post.text),
        langStr,
      });
      diaryResult = await generateUserDiaryResilient(
        userinfo,
        {
          dayContext,
          mediaReference,
          surface: "nagi",
          label: `[NAGI][${userDid}][DIARY]`,
        },
      );
    } catch (error: any) {
      console.error(
        `[ERROR][NAGI][${userDid}][DIARY] Failed to generate diary after up to ${DIARY_MAX_ATTEMPTS} attempts:`,
        error.message,
      );
      return "failed";
    }

    const record: NagiDiary = {
      $type: NAGI.diary,
      subject: userDid,
      date,
      text: clipNagiPostText(diaryResult.diary, "DIARY"),
      titleJa: diaryResult.title_ja,
      titleEn: diaryResult.title_en,
      postCount: recentPosts.length,
      ...(latestLangs?.length ? { langs: latestLangs } : {}),
      createdAt: new Date().toISOString(),
    };

    await retry(
      async () => {
        // 日記は本人だけが読む。PDS へ置くと botたんの公開リポジトリから誰でも読めてしまうので、
        // こっそりを含むかどうかにかかわらず AppView にだけ作る。
        await createDiary({
          rkey: diaryRkey(userDid, date),
          record: { ...record, isPrivate },
        });
      },
      {
        retries: 2,
        onRetry: (error, attempt) => {
          console.warn(`[WARN][NAGI][${userDid}][DIARY] create retry ${attempt}:`, error);
        },
      },
    );

    console.info(`[INFO][DIARY] diary_published surface=nagi subject=${userDid} date=${date}`);

    // 称号は Bluesky と共通。ラベルは24時間で切れるが、Nagi のバッジ表示元である
    // followers.current_title_* は次の日記まで残る。失敗しても日記自体は成立させる。
    try {
      await applyDiaryTitle(userDid, diaryResult);
    } catch (error: any) {
      console.error(
        `[ERROR][NAGI][BADGE][DIARY] Failed to apply title badge for ${userDid}:`,
        error.message,
      );
    }

    console.log(`[INFO][NAGI][${userDid}] finish to process diary (${date})`);
    return "done";
  } catch (error) {
    console.error(`[ERROR][NAGI][${userDid}] an error occured in diary process:`, error);
    return "failed";
  }
}

function runNagiDiary(job: DiaryJob) {
  processNagiDiary(job.did, job.window)
    .catch((error) => {
      console.error(`[ERROR][NAGI][${job.did}]`, error);
      return "failed" as const;
    })
    .then((outcome) => finishDiaryJob(job, outcome))
    .catch((error) => console.error(`[ERROR][NAGI][${job.did}] failed to finish diary job`, error));
}

/** 書く面を決め（Bluesky 側と同じ関数）、Nagi に決まった行を取って書く。 */
async function scanNagiDiaries() {
  await decideDiaryJobs();
  for (const job of await claimDiaryJobs("nagi")) {
    console.log(
      `[INFO][NAGI][${job.did}] writing diary for ${job.window.date} (attempt ${job.attempts})`,
    );
    runNagiDiary(job);
  }
}

/** 起動時に呼ぶ。以降は SCAN_INTERVAL_MS ごとに見回る。 */
export async function scheduleAllNagiDiaries() {
  console.log("[INFO][NAGI][DIARY] start diary scan");

  startWorkerLoop({
    name: "NAGI_DIARY",
    intervalMs: SCAN_INTERVAL_MS,
    tick: scanNagiDiaries,
  });

  await scanNagiDiaries();
}

/**
 * ユーザーのデータ削除時に、その人の日記を消す。今の日記は AppView にしか無いが、
 * 移行前に bot のリポジトリへ書いた日記が残っていれば、そのレコードも消す。
 */
export async function purgeNagiDiaries(userDid: string): Promise<number> {
  const rows = await db
    .select({ uri: nagiDiaries.uri })
    .from(nagiDiaries)
    .where(eq(nagiDiaries.subjectDid, userDid));

  const legacyPrefix = `at://${process.env.NAGI_BOT_DID}/${NAGI.diary}/`;
  let deleted = 0;
  for (const { uri } of rows) {
    // AppView にだけある日記は PDS に無いので、下の行削除だけで完全に消える。
    if (!uri.startsWith(legacyPrefix)) continue;
    const rkey = uri.split("/").pop();
    if (!rkey) continue;
    try {
      await trackedDeleteRecord(agent, {
        repo: process.env.NAGI_BOT_DID!,
        collection: NAGI.diary,
        rkey,
      }, "nagi.diary.purge");
      deleted += 1;
    } catch (error) {
      console.error(`[ERROR][NAGI][DIARY] Failed to delete diary record ${uri}:`, error);
    }
  }
  // AppView 側の行は deleteAccountData が消すが、レコード削除イベントの取りこぼしに
  // 備えてここでも落としておく。
  await db.delete(nagiDiaries).where(eq(nagiDiaries.subjectDid, userDid));
  return deleted;
}
