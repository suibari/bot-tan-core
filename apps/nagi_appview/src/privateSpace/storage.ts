import {
  db,
  nagiBookmarkFolders,
  nagiBookmarkPreferences,
  nagiBookmarks,
  nagiDiaryDayPreferences,
  nagiDrafts,
  nagiEmojiFavorites,
  nagiFeedTabs,
  nagiLanguagePreferences,
  nagiModerationPreferences,
  nagiMutes,
  nagiNotificationPreferences,
  nagiPrivateListMembers,
  nagiPrivateSpaces,
  nagiTagFavorites,
} from "@bsky-affirmative-bot/database";
import {
  nagiPrivateSpaceUri,
  type ExportPrivateDataView,
  type PrivateSpaceStatusView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { asc, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import { toPrivateSpaceRecords, type PrivateRows } from "./records.js";
import { loadPrivateStorage, storageMode, type StorageRow } from "./guard.js";

/**
 * 本人の非公開データの保存先。docs/atproto-spaces-migration.md 3.5 / 4章。
 *
 * ここで扱うのは「どこが正本か」の切り替えと、移行用の書き出し。門番は guard.ts。
 * space との通信（作成・書き込み・取り込み）は β 後に足す。
 */

const statusView = (row: StorageRow | undefined): PrivateSpaceStatusView => ({
  enabled: config.privateSpaceEnabled,
  storage: storageMode(row),
  ...(row ? { space: row.spaceUri, changedAt: row.changedAt.toISOString() } : {}),
});

export async function getPrivateSpaceStatus(did: string) {
  return statusView(await loadPrivateStorage(did));
}

/**
 * 移行を始める。同じ space で既に移行中なら、そのまま続けられるよう成功を返す
 * （途中で閉じたタブからの再開）。
 */
export async function beginPrivateSpaceMigration(
  did: string,
  space: unknown,
): Promise<PrivateSpaceStatusView> {
  if (!config.privateSpaceEnabled)
    throw new ApiError(404, "not_enabled", "Private space migration is not enabled");
  // authority を本人に固定する。他人の space を自分の正本として登録させない。
  if (space !== nagiPrivateSpaceUri(did))
    throw new ApiError(400, "invalid_request", "space must be your own Nagi private space");
  const spaceUri = space as string;
  return db.transaction(async (tx) => {
    // ブックマーク・下書き・非公開リストの書き込みと同じロック。門番の確認から書き込みまでの
    // 間に移行が始まって、書き出しから漏れる行ができないようにする。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${did}))`);
    const current = await loadPrivateStorage(did, tx);
    if (storageMode(current) === "space")
      throw new ApiError(409, "already_migrated", "Private data is already in your PDS");
    if (storageMode(current) === "migrating") return statusView(current);
    const [row] = await tx
      .insert(nagiPrivateSpaces)
      .values({ did, storage: "migrating", spaceUri })
      .onConflictDoUpdate({
        target: nagiPrivateSpaces.did,
        set: { storage: "migrating", spaceUri, changedAt: new Date() },
      })
      .returning();
    return statusView(row);
  });
}

/**
 * AppView 保存へ戻す。移行中の中断にも、移行後に戻すのにも使う。
 * AppView のテーブルは space から取り込んだコピーのまま残っているので、そのまま正本に戻れる。
 * 本人の PDS の space は消さない（本人の持ち物。消すならクライアントが deleteSpace する）。
 */
export async function abortPrivateSpaceMigration(
  did: string,
): Promise<PrivateSpaceStatusView> {
  const [row] = await db
    .update(nagiPrivateSpaces)
    .set({ storage: "appview", changedAt: new Date() })
    .where(eq(nagiPrivateSpaces.did, did))
    .returning();
  return statusView(row);
}

async function loadPrivateRows(did: string): Promise<PrivateRows> {
  const single = async <T>(rows: Promise<T[]>) => (await rows)[0];
  const [
    mutes,
    privateListMembers,
    bookmarkFolders,
    bookmarks,
    drafts,
    languagePreferences,
    moderationPreferences,
    notificationPreferences,
    bookmarkPreferences,
    diaryDayPreferences,
    emojiFavorites,
    tagFavorites,
    feedTabs,
  ] = await Promise.all([
    db.select().from(nagiMutes).where(eq(nagiMutes.muterDid, did)),
    db
      .select()
      .from(nagiPrivateListMembers)
      .where(eq(nagiPrivateListMembers.ownerDid, did)),
    db
      .select()
      .from(nagiBookmarkFolders)
      .where(eq(nagiBookmarkFolders.ownerDid, did))
      .orderBy(asc(nagiBookmarkFolders.createdAt)),
    db
      .select()
      .from(nagiBookmarks)
      .where(eq(nagiBookmarks.ownerDid, did))
      .orderBy(asc(nagiBookmarks.createdAt)),
    db.select().from(nagiDrafts).where(eq(nagiDrafts.ownerDid, did)),
    single(
      db
        .select()
        .from(nagiLanguagePreferences)
        .where(eq(nagiLanguagePreferences.did, did)),
    ),
    single(
      db
        .select()
        .from(nagiModerationPreferences)
        .where(eq(nagiModerationPreferences.did, did)),
    ),
    single(
      db
        .select()
        .from(nagiNotificationPreferences)
        .where(eq(nagiNotificationPreferences.did, did)),
    ),
    single(
      db
        .select()
        .from(nagiBookmarkPreferences)
        .where(eq(nagiBookmarkPreferences.did, did)),
    ),
    single(
      db
        .select()
        .from(nagiDiaryDayPreferences)
        .where(eq(nagiDiaryDayPreferences.did, did)),
    ),
    single(db.select().from(nagiEmojiFavorites).where(eq(nagiEmojiFavorites.did, did))),
    single(db.select().from(nagiTagFavorites).where(eq(nagiTagFavorites.did, did))),
    single(db.select().from(nagiFeedTabs).where(eq(nagiFeedTabs.did, did))),
  ]);
  return {
    mutes,
    privateListMembers,
    bookmarkFolders,
    bookmarks,
    drafts,
    languagePreferences,
    moderationPreferences,
    notificationPreferences,
    bookmarkPreferences,
    diaryDayPreferences,
    emojiFavorites,
    tagFavorites,
    feedTabs,
  };
}

/**
 * 移行中だけ、AppView の行を space へ書く形で返す。移行中は書き込みを止めているので、
 * ここで返した内容と space に書いた内容のあいだに AppView 側の更新は入らない。
 */
export async function exportPrivateData(did: string): Promise<ExportPrivateDataView> {
  if (storageMode(await loadPrivateStorage(did)) !== "migrating")
    throw new ApiError(409, "not_migrating", "Begin the migration first");
  return { records: toPrivateSpaceRecords(await loadPrivateRows(did)) };
}
