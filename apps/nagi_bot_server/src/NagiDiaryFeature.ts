import { and, eq } from "drizzle-orm";
import {
  db,
  MemoryService,
  nagiActors,
  nagiDiaries,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  applyDiaryTitle,
  buildUserDiaryContext,
  calculateDelayUntilLocal22,
  getLangStr,
  getTimezoneFromLang,
  isPastLocal22,
  localDateStr,
  trackedDeleteRecord,
  withPreferredName,
  selectUserDiaryMediaReference,
} from "@bsky-affirmative-bot/clients";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const RESCAN_INTERVAL_MS = 60 * 60 * 1000;

// 多重スケジュール抑止用。値が null なのは「タイマー待ちではなく今まさに実行中」。
const scheduledTimers = new Map<string, NodeJS.Timeout | null>();

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

export type NagiDiaryRunOptions = {
  /**
   * 収集窓の終端。既定は現在時刻で、材料は [until-24h, until] のポスト。
   * 過去日をバックフィルするときはその日のローカル22時を渡す。
   */
  until?: Date;
  /** 生成する日記の日付 "YYYY-MM-DD"。既定は until のユーザーローカル日付。 */
  date?: string;
  /** ポストの言語から決まるタイムゾーンの上書き。 */
  timezone?: string;
};

/**
 * 1ユーザー分の日記を書く。
 * ポストではなく com.suibari.nagi.diary レコードを AppView にだけ作るので、
 * グローバルタイムラインには出ない。日記は本人だけが読むもので、PDS には書かない。
 * 通知は AppView が取り込み時に作る。
 *
 * 引数なしで呼べば「今この瞬間から24時間ぶん」を今日の日記として書く（定時実行の経路）。
 * options を渡すと過去日のバックフィルになる（scripts/backfillNagiDiary.ts）。
 * どちらでも (subject, date) の存在チェックが二重生成を防ぐ。
 */
export async function processNagiDiary(
  userDid: string,
  options: NagiDiaryRunOptions = {},
): Promise<void> {
  try {
    console.log(`[INFO][NAGI][${userDid}] Processing diary...`);

    const until = options.until ?? new Date();
    const since = new Date(until.getTime() - DAY_MS);
    // getNagiPostsSince は下限しか持たないので、窓の終端はここで切る。
    // 定時実行では until = 現在時刻なので、この絞り込みは何も落とさない。
    const recentPosts = (
      await MemoryService.getNagiPostsSince(userDid, since)
    ).filter((post) => !post.recordCreatedAt || post.recordCreatedAt <= until);
    if (recentPosts.length === 0) {
      console.log(`[INFO][NAGI][${userDid}] today's post not found`);
      return;
    }

    // こっそりを1つでも含む日かどうか。日記はどれも本人限定なので出し分けには使わず、記録として残す。
    const isPrivate = recentPosts.some((post) => post.kossori);

    const latestLangs = [...recentPosts]
      .reverse()
      .find((post) => Array.isArray(post.langs) && post.langs.length)?.langs as
      | string[]
      | undefined;
    const langStr = getLangStr(latestLangs);
    const timezone = options.timezone ?? getTimezoneFromLang(latestLangs?.[0]);
    const date = options.date ?? localDateStr(timezone, until);

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
      return;
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
      // 使い切っても、22時を過ぎている人は毎時の再スキャンが拾い直す。
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
          label: `[NAGI][${userDid}][DIARY]`,
        },
      );
    } catch (error: any) {
      console.error(
        `[ERROR][NAGI][${userDid}][DIARY] Failed to generate diary after up to ${DIARY_MAX_ATTEMPTS} attempts:`,
        error.message,
      );
      return;
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
  } catch (error) {
    console.error(`[ERROR][NAGI][${userDid}] an error occured in diary process:`, error);
  }
}

/** 実行中も scheduledTimers に居座らせて、毎時の再スキャンによる二重起動を防ぐ。 */
function runNagiDiary(userDid: string) {
  processNagiDiary(userDid)
    .catch((error) => console.error(`[ERROR][NAGI][${userDid}]`, error))
    .finally(() => {
      scheduledTimers.delete(userDid); // 終了後に削除
    });
}

/**
 * ユーザーのローカル22時に日記処理を1回だけ予約する。
 * すでに22時を回っているなら即実行する。setTimeout に任せると次は約24時間後になり、
 * 生成失敗やプロセス再起動でその日の日記が丸ごと欠測してしまうため。
 * 二重に書かないことは processNagiDiary の (subject, date) 存在チェックが担保する。
 */
function scheduleUserDiary(userDid: string, timezone: string) {
  if (scheduledTimers.has(userDid)) return; // すでにスケジュール済み

  if (isPastLocal22(timezone)) {
    console.log(`[INFO][NAGI][${userDid}] past local 22:00, running diary now (tz: ${timezone})`);
    // タイマーは無いが、実行中の印として同じ Map を使う。
    scheduledTimers.set(userDid, null);
    runNagiDiary(userDid);
    return;
  }

  const delay = calculateDelayUntilLocal22(timezone);
  console.log(`[INFO][NAGI][${userDid}] scheduling diary, tz: ${timezone}, next: ${delay}ms`);
  const timer = setTimeout(() => runNagiDiary(userDid), delay);

  scheduledTimers.set(userDid, timer);
}

/**
 * 直近24hに Nagi へ投稿したユーザー全員をスケジュールする。
 * Bluesky と違い日記モードのオプトインは無く、投稿があれば書く。
 */
async function manageNagiDiarySchedules() {
  const since = new Date(Date.now() - DAY_MS);
  const botDid = process.env.NAGI_BOT_DID;
  const authors = (await MemoryService.getNagiActiveAuthorsSince(since)).filter(
    (did) => did !== botDid,
  );

  if (authors.length === 0) {
    console.log("[INFO][NAGI][DIARY] no active author for diary");
    return;
  }
  console.log(`[INFO][NAGI][DIARY] active authors: ${authors.length}`);

  for (const did of authors) {
    if (scheduledTimers.has(did)) continue;
    try {
      const posts = await MemoryService.getNagiPostsSince(did, since);
      const langs = [...posts]
        .reverse()
        .find((post) => Array.isArray(post.langs) && post.langs.length)?.langs as
        | string[]
        | undefined;
      scheduleUserDiary(did, getTimezoneFromLang(langs?.[0]));
    } catch (error) {
      console.error(`[ERROR][NAGI][${did}] error occur in diary scheduling:`, error);
    }
  }
}

/** 起動時に呼ぶ。以降1時間ごとに対象を組み直す。 */
export async function scheduleAllNagiDiaries() {
  console.log("[INFO][NAGI][DIARY] scheduling all user diary");

  setInterval(() => {
    manageNagiDiarySchedules().catch((error) =>
      console.error("[ERROR][NAGI][DIARY] periodic scheduling failed:", error),
    );
  }, RESCAN_INTERVAL_MS);

  await manageNagiDiarySchedules();
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
