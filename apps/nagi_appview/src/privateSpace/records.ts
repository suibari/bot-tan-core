import type {
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
  nagiTagFavorites,
} from "@bsky-affirmative-bot/database";
import {
  NAGI_PRIVATE,
  type DraftContent,
  type EmojiFavorite,
  type FeedTab,
  type MuteSubjectType,
  type NagiPrivateCollection,
  type NotificationPreferences,
  type PrivateSpaceRecordWrite,
  type SyncedLanguagePreferences,
  type SyncedModerationPreferences,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  isDiaryDayStartHour,
  isValidTimezone,
} from "@bsky-affirmative-bot/shared-configs";
import { ApiError } from "../middleware/errors.js";
import {
  bookmarkSubjectType,
  normalizeBookmarkFolderName,
} from "../queries/bookmarks.js";
import { parseDraftContent } from "../queries/drafts.js";
import {
  parseEmojiFavorites,
  parseFeedTabs,
  parseLanguagePreferences,
  parseModerationPreferences,
  parseTagFavorites,
} from "../queries/preferences.js";
import { normalizeTag } from "../queries/tags.js";
import { parseNotificationPreferences } from "../services/notificationPreferences.js";
import {
  bookmarkRkey,
  listMemberRkey,
  muteRkey,
  SELF_RKEY,
} from "./rkeys.js";

/**
 * AppView のテーブル ⇄ 非公開 space のレコード。
 *
 * - 書き出し（toPrivateSpaceRecords）: 移行時に AppView の行を space へ書く形にする。
 * - 読み込み（parsePrivateSpaceRecord）: space から取り込んだレコードを検証して行の形にする。
 *   space は本人が任意の値を書けるので、従来の API の入口と同じ検証を通す。
 *   通らないレコードは取り込まない（InvalidPrivateRecord）。
 *
 * 取り込みの DB 書き込み（相手の行との衝突の扱い）は β 後に作る取り込みワーカー側で行う。
 * ここは純粋関数だけにして、プロトコルが固まる前でもテストできるようにしている。
 */

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

/** 1人分の、space へ移す行。テーブルごとに本人の行だけが入っている前提。 */
export type PrivateRows = {
  mutes: Row<typeof nagiMutes>[];
  privateListMembers: Row<typeof nagiPrivateListMembers>[];
  bookmarkFolders: Row<typeof nagiBookmarkFolders>[];
  bookmarks: Row<typeof nagiBookmarks>[];
  drafts: Row<typeof nagiDrafts>[];
  languagePreferences?: Row<typeof nagiLanguagePreferences>;
  moderationPreferences?: Row<typeof nagiModerationPreferences>;
  notificationPreferences?: Row<typeof nagiNotificationPreferences>;
  bookmarkPreferences?: Row<typeof nagiBookmarkPreferences>;
  diaryDayPreferences?: Row<typeof nagiDiaryDayPreferences>;
  emojiFavorites?: Row<typeof nagiEmojiFavorites>;
  tagFavorites?: Row<typeof nagiTagFavorites>;
  feedTabs?: Row<typeof nagiFeedTabs>;
};

const iso = (date: Date) => date.toISOString();

const write = (
  collection: NagiPrivateCollection,
  rkey: string,
  value: Record<string, unknown>,
): PrivateSpaceRecordWrite => ({
  collection,
  rkey,
  value: { $type: collection, ...value },
});

/**
 * 書き出しの順序はフォルダ → ブックマーク。取り込み側が順に処理しても、
 * ブックマークが指すフォルダが先に存在するようにするため。
 */
export function toPrivateSpaceRecords(rows: PrivateRows): PrivateSpaceRecordWrite[] {
  const records: PrivateSpaceRecordWrite[] = [];
  for (const row of rows.mutes) {
    // channel は廃止したチャンネル機能の名残で、どこからも参照されない（本番は 0 件）。
    if (row.subjectType === "channel") continue;
    records.push(
      write(NAGI_PRIVATE.mute, muteRkey(row.subjectType, row.subject), {
        subjectType: row.subjectType,
        subject: row.subject,
        createdAt: iso(row.createdAt),
      }),
    );
  }
  for (const row of rows.privateListMembers) {
    records.push(
      write(NAGI_PRIVATE.listMember, listMemberRkey(row.memberDid), {
        subject: row.memberDid,
        createdAt: iso(row.createdAt),
      }),
    );
  }
  for (const row of rows.bookmarkFolders) {
    records.push(
      write(NAGI_PRIVATE.bookmarkFolder, row.id, {
        name: row.name,
        isDefault: row.isDefault,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }),
    );
  }
  for (const row of rows.bookmarks) {
    records.push(
      write(NAGI_PRIVATE.bookmark, bookmarkRkey(row.subjectUri), {
        folder: row.folderId,
        subject: row.subjectUri,
        createdAt: iso(row.createdAt),
      }),
    );
  }
  for (const row of rows.drafts) {
    records.push(
      write(NAGI_PRIVATE.draft, row.id, {
        content: row.content,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }),
    );
  }
  const language = rows.languagePreferences;
  if (language) {
    records.push(
      write(NAGI_PRIVATE.languagePreferences, SELF_RKEY, {
        preferences: {
          post: language.postLanguage,
          translation: language.translationLanguage,
          provider: language.translationProvider,
          autoTranslate: language.autoTranslate,
        },
        updatedAt: iso(language.updatedAt),
      }),
    );
  }
  const moderation = rows.moderationPreferences;
  if (moderation) {
    records.push(
      write(NAGI_PRIVATE.moderationPreferences, SELF_RKEY, {
        preferences: {
          automatic: moderation.automatic,
          selfAi: moderation.selfAi,
          selfNsfw: moderation.selfNsfw,
        },
        updatedAt: iso(moderation.updatedAt),
      }),
    );
  }
  const notification = rows.notificationPreferences;
  if (notification) {
    records.push(
      write(NAGI_PRIVATE.notificationPreferences, SELF_RKEY, {
        preferences: notification.preferences,
        updatedAt: iso(notification.updatedAt),
      }),
    );
  }
  const bookmark = rows.bookmarkPreferences;
  if (bookmark) {
    records.push(
      write(NAGI_PRIVATE.bookmarkPreferences, SELF_RKEY, {
        ...(bookmark.lastFolderId ? { lastFolder: bookmark.lastFolderId } : {}),
        updatedAt: iso(bookmark.updatedAt),
      }),
    );
  }
  // 自動検出のタイムゾーンは AppView に残すので、本人が選んだ値が1つも無ければ書かない。
  const diaryDay = rows.diaryDayPreferences;
  if (diaryDay && (diaryDay.manualTimezone || diaryDay.startHour !== null)) {
    records.push(
      write(NAGI_PRIVATE.diaryDay, SELF_RKEY, {
        ...(diaryDay.manualTimezone ? { timezone: diaryDay.manualTimezone } : {}),
        ...(diaryDay.startHour !== null ? { startHour: diaryDay.startHour } : {}),
        updatedAt: iso(diaryDay.updatedAt),
      }),
    );
  }
  if (rows.emojiFavorites) {
    records.push(
      write(NAGI_PRIVATE.emojiFavorites, SELF_RKEY, {
        choices: rows.emojiFavorites.choices,
        updatedAt: iso(rows.emojiFavorites.updatedAt),
      }),
    );
  }
  if (rows.tagFavorites) {
    records.push(
      write(NAGI_PRIVATE.tagFavorites, SELF_RKEY, {
        tags: rows.tagFavorites.tags,
        updatedAt: iso(rows.tagFavorites.updatedAt),
      }),
    );
  }
  if (rows.feedTabs) {
    records.push(
      write(NAGI_PRIVATE.feedTabs, SELF_RKEY, {
        tabs: rows.feedTabs.tabs,
        updatedAt: iso(rows.feedTabs.updatedAt),
      }),
    );
  }
  return records;
}

/** 取り込めないレコード。取り込みワーカーはこれを数えてログに出し、そのレコードだけ飛ばす。 */
export class InvalidPrivateRecord extends Error {
  constructor(
    public collection: string,
    public rkey: string,
    reason: string,
  ) {
    super(`${collection}/${rkey}: ${reason}`);
  }
}

export type ParsedPrivateRecord =
  | { kind: "mute"; subjectType: MuteSubjectType; subject: string; createdAt: Date }
  | { kind: "listMember"; memberDid: string; createdAt: Date }
  | {
      kind: "bookmarkFolder";
      id: string;
      name: string;
      isDefault: boolean;
      createdAt: Date;
      updatedAt: Date;
    }
  | {
      kind: "bookmark";
      folderId: string;
      subjectUri: string;
      subjectType: "post" | "news" | "diary";
      createdAt: Date;
    }
  | {
      kind: "draft";
      id: string;
      content: DraftContent;
      createdAt: Date;
      updatedAt: Date;
    }
  | { kind: "languagePreferences"; preferences: SyncedLanguagePreferences; updatedAt: Date }
  | {
      kind: "moderationPreferences";
      preferences: SyncedModerationPreferences;
      updatedAt: Date;
    }
  | {
      kind: "notificationPreferences";
      preferences: NotificationPreferences;
      updatedAt: Date;
    }
  | { kind: "bookmarkPreferences"; lastFolderId: string | null; updatedAt: Date }
  | {
      kind: "diaryDay";
      manualTimezone: string | null;
      startHour: number | null;
      updatedAt: Date;
    }
  | { kind: "emojiFavorites"; choices: EmojiFavorite[]; updatedAt: Date }
  | { kind: "tagFavorites"; tags: string[]; updatedAt: Date }
  | { kind: "feedTabs"; tabs: FeedTab[]; updatedAt: Date };

export type ParseContext = {
  /** space の authority（= 本人）。 */
  ownerDid: string;
  botDid: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DID_RE = /^did:(plc|web):/;
const MAX_TAG_LENGTH = 640;

/**
 * space のレコードを検証して行の形にする。
 *
 * rkey も検証する。対象から決まる rkey（rkeys.ts）と食い違うレコードを受け入れると、
 * 同じ相手のミュートが2レコードに分かれ、片方を消しても残る。
 */
export function parsePrivateSpaceRecord(
  collection: string,
  rkey: string,
  value: unknown,
  ctx: ParseContext,
): ParsedPrivateRecord {
  const fail = (reason: string): never => {
    throw new InvalidPrivateRecord(collection, rkey, reason);
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("value must be an object");
  const record = value as Record<string, unknown>;
  if (record.$type !== undefined && record.$type !== collection)
    fail("$type does not match collection");
  const date = (field: string): Date => {
    const raw = record[field];
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw)))
      fail(`${field} must be a datetime`);
    return new Date(raw as string);
  };
  const self = () => {
    if (rkey !== SELF_RKEY) fail("rkey must be self");
  };
  const uuid = (raw: unknown, field: string): string => {
    if (typeof raw !== "string" || !UUID_RE.test(raw)) fail(`${field} must be a UUID`);
    return (raw as string).toLowerCase();
  };
  // 従来の API の検証関数は ApiError を投げる。取り込みでは理由だけ残して飛ばす。
  const guard = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof ApiError) return fail(error.message);
      throw error;
    }
  };

  switch (collection) {
    case NAGI_PRIVATE.mute: {
      const subjectType = record.subjectType;
      let subject = record.subject;
      if (typeof subject !== "string") return fail("subject must be a string");
      if (subjectType === "actor") {
        if (!DID_RE.test(subject)) fail("subject must be a DID");
        if (subject === ctx.ownerDid) fail("cannot mute yourself");
      } else if (subjectType === "tag") {
        subject = normalizeTag(subject);
        if (!subject || (subject as string).length > MAX_TAG_LENGTH)
          fail("subject must be a hashtag");
      } else {
        return fail("unknown subjectType");
      }
      if (rkey !== muteRkey(subjectType, subject as string)) fail("rkey does not match subject");
      return {
        kind: "mute",
        subjectType,
        subject: subject as string,
        createdAt: date("createdAt"),
      };
    }
    case NAGI_PRIVATE.listMember: {
      const subject = record.subject;
      if (typeof subject !== "string" || !DID_RE.test(subject))
        return fail("subject must be a DID");
      if (subject === ctx.ownerDid) fail("cannot add yourself");
      if (subject === ctx.botDid) fail("bot-tan is already in Home");
      if (rkey !== listMemberRkey(subject)) fail("rkey does not match subject");
      return { kind: "listMember", memberDid: subject, createdAt: date("createdAt") };
    }
    case NAGI_PRIVATE.bookmarkFolder: {
      if (typeof record.isDefault !== "boolean") fail("isDefault must be a boolean");
      return {
        kind: "bookmarkFolder",
        id: uuid(rkey, "rkey"),
        name: guard(() => normalizeBookmarkFolderName(record.name)),
        isDefault: record.isDefault as boolean,
        createdAt: date("createdAt"),
        updatedAt: date("updatedAt"),
      };
    }
    case NAGI_PRIVATE.bookmark: {
      const subject = record.subject;
      if (typeof subject !== "string") return fail("subject must be an AT URI");
      const subjectType = guard(() => bookmarkSubjectType(subject));
      if (rkey !== bookmarkRkey(subject)) fail("rkey does not match subject");
      return {
        kind: "bookmark",
        folderId: uuid(record.folder, "folder"),
        subjectUri: subject,
        subjectType,
        createdAt: date("createdAt"),
      };
    }
    case NAGI_PRIVATE.draft:
      return {
        kind: "draft",
        id: uuid(rkey, "rkey"),
        content: guard(() => parseDraftContent(record.content)),
        createdAt: date("createdAt"),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.languagePreferences:
      self();
      return {
        kind: "languagePreferences",
        preferences: guard(() => parseLanguagePreferences(record.preferences)),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.moderationPreferences:
      self();
      return {
        kind: "moderationPreferences",
        preferences: guard(() => parseModerationPreferences(record.preferences)),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.notificationPreferences:
      self();
      return {
        kind: "notificationPreferences",
        preferences: guard(() => parseNotificationPreferences(record.preferences)),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.bookmarkPreferences:
      self();
      return {
        kind: "bookmarkPreferences",
        lastFolderId:
          record.lastFolder === undefined ? null : uuid(record.lastFolder, "lastFolder"),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.diaryDay: {
      self();
      const { timezone, startHour } = record;
      if (timezone !== undefined && !isValidTimezone(timezone)) fail("timezone is invalid");
      if (startHour !== undefined && !isDiaryDayStartHour(startHour))
        fail("startHour is invalid");
      return {
        kind: "diaryDay",
        manualTimezone: (timezone as string | undefined) ?? null,
        startHour: (startHour as number | undefined) ?? null,
        updatedAt: date("updatedAt"),
      };
    }
    case NAGI_PRIVATE.emojiFavorites:
      self();
      return {
        kind: "emojiFavorites",
        choices: guard(() => parseEmojiFavorites(record.choices)),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.tagFavorites:
      self();
      return {
        kind: "tagFavorites",
        tags: guard(() => parseTagFavorites(record.tags)),
        updatedAt: date("updatedAt"),
      };
    case NAGI_PRIVATE.feedTabs:
      self();
      return {
        kind: "feedTabs",
        tabs: guard(() => parseFeedTabs(record.tabs)),
        updatedAt: date("updatedAt"),
      };
    default:
      return fail("unknown collection");
  }
}
