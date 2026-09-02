import {
  db,
  followers,
  nagiEmojiFavorites,
  nagiFeedTabs,
  nagiBookmarkFolders,
  nagiBookmarkPreferences,
  nagiLanguagePreferences,
  nagiPreferredNames,
  nagiReadPositions,
} from "@bsky-affirmative-bot/database";
import {
  EMOJI_FAVORITES_LIMIT,
  FEED_TAB_KINDS,
  FEED_TABS_LIMIT,
  NAGI_SUPPORTED_LANGUAGES,
  READ_POSITION_SECTIONS,
  type EmojiFavorite,
  type FeedTab,
  type FeedTabKind,
  type PreferencesView,
  type PutPreferencesInput,
  type ReadPosition,
  type ReadPositionSection,
  type SyncedLanguagePreferences,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { eq, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { declareBirthDate, getAgeAssurance } from "../services/ageAssurance.js";

const MAX_URI_LENGTH = 2048;
const MAX_UNICODE_EMOJI_LENGTH = 64;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE_VALUES = new Set<string>([
  "browser",
  ...NAGI_SUPPORTED_LANGUAGES,
]);
const TRANSLATION_PROVIDERS = new Set(["kagi", "deepl", "google"]);

const isSection = (value: unknown): value is ReadPositionSection =>
  READ_POSITION_SECTIONS.includes(value as ReadPositionSection);

const invalid = (field: string): never => {
  throw new ApiError(400, "invalid_request", `Invalid ${field}`);
};

/** 入力は他人が書いた JSON として扱う。publish した lexicon は AppView を検証してくれない。 */
function parseReadPositions(input: unknown): ReadPosition[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > READ_POSITION_SECTIONS.length)
    invalid("readPositions");
  const seen = new Set<string>();
  return (input as unknown[]).map((raw) => {
    const item = (raw ?? {}) as Partial<ReadPosition>;
    if (!isSection(item.section)) invalid("readPositions.section");
    const section = item.section as ReadPositionSection;
    // 同じセクションを2つ送られると単調マージの勝敗が入力順に依存してしまう。
    if (seen.has(section)) invalid("readPositions.section (duplicate)");
    seen.add(section);
    if (
      typeof item.uri !== "string" ||
      !item.uri ||
      item.uri.length > MAX_URI_LENGTH
    )
      invalid("readPositions.uri");
    if (
      typeof item.indexedAt !== "string" ||
      Number.isNaN(Date.parse(item.indexedAt))
    )
      invalid("readPositions.indexedAt");
    return {
      section,
      indexedAt: item.indexedAt as string,
      uri: item.uri as string,
    };
  });
}

/**
 * お気に入りはクライアントの localStorage と同じ形をそのまま預かる。中身は表示用の
 * スナップショットで、権威は custom なら uri（クライアントが getEmoji で再解決する）。
 * ここでは「他人のデータで DB を膨らませない」ための最低限の形だけ確認する。
 */
function parseEmojiFavorites(input: unknown): EmojiFavorite[] {
  if (!Array.isArray(input) || input.length > EMOJI_FAVORITES_LIMIT)
    invalid("emojiFavorites");
  return (input as unknown[]).map((raw) => {
    const item = (raw ?? {}) as { kind?: unknown; emoji?: unknown };
    if (item.kind === "unicode") {
      if (
        typeof item.emoji !== "string" ||
        !item.emoji ||
        item.emoji.length > MAX_UNICODE_EMOJI_LENGTH
      )
        invalid("emojiFavorites");
      return { kind: "unicode" as const, emoji: item.emoji as string };
    }
    if (item.kind !== "custom" || !item.emoji || typeof item.emoji !== "object")
      invalid("emojiFavorites");
    const emoji = item.emoji as Record<string, unknown>;
    for (const key of ["uri", "cid", "did", "name", "url", "mediaType"]) {
      const value = emoji[key];
      if (typeof value !== "string" || !value) invalid("emojiFavorites");
    }
    if ((emoji.uri as string).length > MAX_URI_LENGTH)
      invalid("emojiFavorites");
    return { kind: "custom" as const, emoji } as EmojiFavorite;
  });
}

function parseUpdatedAt(field: string, input: unknown): Date {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)))
    throw new ApiError(
      400,
      "invalid_request",
      `${field} is required with ${field.replace("UpdatedAt", "")}`,
    );
  return new Date(input);
}

export function parseLanguagePreferences(
  input: unknown,
): SyncedLanguagePreferences {
  if (!input || typeof input !== "object") invalid("languagePreferences");
  const item = input as Record<string, unknown>;
  if (!LANGUAGE_VALUES.has(String(item.post)))
    invalid("languagePreferences.post");
  if (!LANGUAGE_VALUES.has(String(item.translation)))
    invalid("languagePreferences.translation");
  if (!TRANSLATION_PROVIDERS.has(String(item.provider)))
    invalid("languagePreferences.provider");
  if (typeof item.autoTranslate !== "boolean")
    invalid("languagePreferences.autoTranslate");
  return {
    post: item.post as SyncedLanguagePreferences["post"],
    translation: item.translation as SyncedLanguagePreferences["translation"],
    provider: item.provider as SyncedLanguagePreferences["provider"],
    autoTranslate: item.autoTranslate as boolean,
  };
}

const isFeedTabKind = (value: unknown): value is FeedTabKind =>
  FEED_TAB_KINDS.includes(value as FeedTabKind);

const MAX_TAB_ID_LENGTH = 64;
const MAX_TAB_QUERY_LENGTH = 128;
const MAX_TAB_LABEL_LENGTH = 64;

/**
 * フィードのタブ。クライアントの normalizeFeedTabs と同じルールで見る
 * （片方だけ緩いと、弾かれない値が入って描画側で落ちる）。
 * 未知フィールドは落とし、任意の JSON を DB に貯めさせない。
 */
function parseFeedTabs(input: unknown): FeedTab[] {
  if (!Array.isArray(input) || input.length > FEED_TABS_LIMIT)
    invalid("feedTabs");
  const seen = new Set<string>();
  return (input as unknown[]).map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !id || id.length > MAX_TAB_ID_LENGTH)
      invalid("feedTabs.id");
    // id が重なると、クライアントが ?tab= で引くタブが入力順に依存してしまう。
    if (seen.has(id as string)) invalid("feedTabs.id (duplicate)");
    seen.add(id as string);
    const kind = item.kind;
    if (!isFeedTabKind(kind)) invalid("feedTabs.kind");
    const tab: FeedTab = { id: id as string, kind: kind as FeedTabKind };
    if (typeof item.label === "string" && item.label)
      tab.label = (item.label as string).slice(0, MAX_TAB_LABEL_LENGTH);
    // list / custom は「入れ物」で、どれを指すかは source が持つ。
    // 今はそれぞれ1つずつしか無いので、未指定なら既定へ寄せる。
    if (tab.kind === "list") {
      if (item.source !== undefined && item.source !== "home")
        invalid("feedTabs.source");
      tab.source = "home";
    }
    if (tab.kind === "custom") {
      if (item.source !== undefined && item.source !== "affirmation")
        invalid("feedTabs.source");
      tab.source = "affirmation";
    }
    if (tab.kind === "channel") {
      const uri = item.uri;
      if (
        typeof uri !== "string" ||
        !uri.startsWith("at://") ||
        uri.length > MAX_URI_LENGTH
      )
        invalid("feedTabs.uri");
      tab.uri = uri as string;
    }
    if (tab.kind === "search") {
      const query =
        typeof item.query === "string" ? (item.query as string).trim() : "";
      if (!query || query.length > MAX_TAB_QUERY_LENGTH)
        invalid("feedTabs.query");
      if (
        item.queryKind !== undefined &&
        !["keyword", "tag"].includes(item.queryKind as string)
      )
        invalid("feedTabs.queryKind");
      tab.query = query;
      tab.queryKind = (item.queryKind as "keyword" | "tag") ?? "keyword";
    }
    return tab;
  });
}

/** 呼び名の上限。lexicon の maxGraphemes と揃えること。 */
const MAX_PREFERRED_NAME_LENGTH = 40;

/**
 * 呼び名は他の設定と違い updatedAt による後勝ちにしない。1個の短い文字列で、
 * 端末間で競合しても「本人が最後に入力したもの」が常に正しいため。
 * 空文字は「解除」の意味で、行ごと消して表示名に戻す。
 */
function parsePreferredName(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") invalid("preferredName");
  const name = (input as string).trim();
  if (!name) return null;
  if ([...name].length > MAX_PREFERRED_NAME_LENGTH) invalid("preferredName");
  if (/[\r\n]/.test(name)) invalid("preferredName");
  return name;
}

function parseReplyFreq(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0 ||
    input > 100
  ) {
    invalid("replyFreq");
  }
  return input as number;
}

async function selectPreferences(did: string): Promise<PreferencesView> {
  const [
    positions,
    favorites,
    feedTabs,
    preferredNames,
    followerRows,
    languageRows,
    bookmarkRows,
  ] = await Promise.all([
    db
      .select({
        section: nagiReadPositions.section,
        indexedAt: nagiReadPositions.indexedAt,
        uri: nagiReadPositions.uri,
      })
      .from(nagiReadPositions)
      .where(eq(nagiReadPositions.did, did)),
    db
      .select({
        choices: nagiEmojiFavorites.choices,
        updatedAt: nagiEmojiFavorites.updatedAt,
      })
      .from(nagiEmojiFavorites)
      .where(eq(nagiEmojiFavorites.did, did))
      .limit(1),
    db
      .select({ tabs: nagiFeedTabs.tabs, updatedAt: nagiFeedTabs.updatedAt })
      .from(nagiFeedTabs)
      .where(eq(nagiFeedTabs.did, did))
      .limit(1),
    db
      .select({ name: nagiPreferredNames.name })
      .from(nagiPreferredNames)
      .where(eq(nagiPreferredNames.did, did))
      .limit(1),
    db
      .select({ reply_freq: followers.reply_freq })
      .from(followers)
      .where(eq(followers.did, did))
      .limit(1),
    db
      .select()
      .from(nagiLanguagePreferences)
      .where(eq(nagiLanguagePreferences.did, did))
      .limit(1),
    db
      .select()
      .from(nagiBookmarkPreferences)
      .where(eq(nagiBookmarkPreferences.did, did))
      .limit(1),
  ]);
  const favoritesRow = favorites[0];
  const feedTabsRow = feedTabs[0];
  const preferredName = preferredNames[0]?.name;
  const followerRow = followerRows[0];
  const languageRow = languageRows[0];
  const bookmarkRow = bookmarkRows[0];
  return {
    readPositions: positions
      .filter((row) => isSection(row.section))
      .map((row) => ({
        section: row.section as ReadPositionSection,
        indexedAt: row.indexedAt.toISOString(),
        uri: row.uri,
      })),
    emojiFavorites: Array.isArray(favoritesRow?.choices)
      ? (favoritesRow.choices as EmojiFavorite[])
      : [],
    // 未同期（行が無い）なら省略する。クライアントはこれを「初回同期」の合図に使う。
    ...(favoritesRow
      ? { emojiFavoritesUpdatedAt: favoritesRow.updatedAt.toISOString() }
      : {}),
    feedTabs: Array.isArray(feedTabsRow?.tabs)
      ? (feedTabsRow.tabs as FeedTab[])
      : [],
    // 行が無い＝一度もカスタムしていない。クライアントはこれを既定タブの合図に使う。
    ...(feedTabsRow
      ? { feedTabsUpdatedAt: feedTabsRow.updatedAt.toISOString() }
      : {}),
    replyFreq: followerRow?.reply_freq != null ? followerRow.reply_freq : 100,
    // 未設定なら省略する。クライアントはこれを「表示名で呼ばれる」の合図に使う。
    ...(preferredName ? { preferredName } : {}),
    ...(languageRow
      ? {
          languagePreferences: {
            post: languageRow.postLanguage as SyncedLanguagePreferences["post"],
            translation:
              languageRow.translationLanguage as SyncedLanguagePreferences["translation"],
            provider:
              languageRow.translationProvider as SyncedLanguagePreferences["provider"],
            autoTranslate: languageRow.autoTranslate,
          },
          languagePreferencesUpdatedAt: languageRow.updatedAt.toISOString(),
        }
      : {}),
    ...(bookmarkRow
      ? {
          ...(bookmarkRow.lastFolderId
            ? { lastBookmarkFolderId: bookmarkRow.lastFolderId }
            : {}),
          lastBookmarkFolderUpdatedAt: bookmarkRow.updatedAt.toISOString(),
        }
      : {}),
  };
}

/** 本人の同期設定を返す唯一の読み出し口。呼び出し側は必ず requiredServiceAuth を使うこと。 */
export async function getPreferences(did: string): Promise<PreferencesView> {
  // 年齢確認は専用の lexicon を足さず設定へ相乗りさせる。新しい XRPC を公開すると
  // permission-set の再公開が要り、認可サーバのキャッシュが最大24時間残るため。
  const [preferences, age] = await Promise.all([
    selectPreferences(did),
    getAgeAssurance(did),
  ]);
  return {
    ...preferences,
    ageAssurance: { isAdult: age.isAdult, declared: age.declared },
  };
}

export async function putPreferences(
  did: string,
  input: PutPreferencesInput,
): Promise<PreferencesView> {
  const readPositions = parseReadPositions(input.readPositions);
  const hasFavorites = input.emojiFavorites !== undefined;
  const emojiFavorites = hasFavorites
    ? parseEmojiFavorites(input.emojiFavorites)
    : [];
  const favoritesUpdatedAt = hasFavorites
    ? parseUpdatedAt("emojiFavoritesUpdatedAt", input.emojiFavoritesUpdatedAt)
    : undefined;
  const hasFeedTabs = input.feedTabs !== undefined;
  const feedTabs = hasFeedTabs ? parseFeedTabs(input.feedTabs) : [];
  const feedTabsUpdatedAt = hasFeedTabs
    ? parseUpdatedAt("feedTabsUpdatedAt", input.feedTabsUpdatedAt)
    : undefined;
  const preferredName = parsePreferredName(input.preferredName);
  const replyFreq = parseReplyFreq(input.replyFreq);
  const hasLanguagePreferences = input.languagePreferences !== undefined;
  const languagePreferences = hasLanguagePreferences
    ? parseLanguagePreferences(input.languagePreferences)
    : undefined;
  const languagePreferencesUpdatedAt = hasLanguagePreferences
    ? parseUpdatedAt(
        "languagePreferencesUpdatedAt",
        input.languagePreferencesUpdatedAt,
      )
    : undefined;
  const hasLastBookmarkFolder = input.lastBookmarkFolderId !== undefined;
  const lastBookmarkFolderId = input.lastBookmarkFolderId;
  if (
    hasLastBookmarkFolder &&
    lastBookmarkFolderId !== null &&
    (typeof lastBookmarkFolderId !== "string" ||
      !UUID_RE.test(lastBookmarkFolderId))
  )
    invalid("lastBookmarkFolderId");
  const lastBookmarkFolderUpdatedAt = hasLastBookmarkFolder
    ? parseUpdatedAt(
        "lastBookmarkFolderUpdatedAt",
        input.lastBookmarkFolderUpdatedAt,
      )
    : undefined;

  // 生年月日は他の設定と違って上書きできない。2度目以降は declareBirthDate が 409。
  if (input.birthDate !== undefined)
    await declareBirthDate(did, {
      birthDate: input.birthDate,
      parentalConsent: input.parentalConsent,
    });

  if (readPositions.length) {
    await db
      .insert(nagiReadPositions)
      .values(
        readPositions.map((position) => ({
          did,
          section: position.section,
          indexedAt: new Date(position.indexedAt),
          uri: position.uri,
        })),
      )
      // 既読は前にしか進まない。復帰の遅れた端末が古い位置を送っても巻き戻らないよう、
      // クライアントの isNewerPosition と同じ (indexedAt, uri) 辞書順で勝った方だけ残す。
      // ON CONFLICT の WHERE では対象行を非修飾のテーブル名で参照する。
      .onConflictDoUpdate({
        target: [nagiReadPositions.did, nagiReadPositions.section],
        set: {
          indexedAt: sql`excluded.indexed_at`,
          uri: sql`excluded.uri`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`(excluded.indexed_at, excluded.uri) > (read_positions.indexed_at, read_positions.uri)`,
      });
  }

  if (favoritesUpdatedAt) {
    // 順序のある1本の配列なので部分マージに意味がない。updated_at による後勝ち。
    // 初回の突き合わせ（サーバとローカルの和集合）はクライアント側で作って送ってくる。
    await db
      .insert(nagiEmojiFavorites)
      .values({ did, choices: emojiFavorites, updatedAt: favoritesUpdatedAt })
      .onConflictDoUpdate({
        target: nagiEmojiFavorites.did,
        set: {
          choices: sql`excluded.choices`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.updated_at > emoji_favorites.updated_at`,
      });
  }

  if (preferredName !== undefined) {
    if (preferredName === null) {
      // 空文字＝解除。行を消せば以後は表示名に戻る。
      await db
        .delete(nagiPreferredNames)
        .where(eq(nagiPreferredNames.did, did));
    } else {
      await db
        .insert(nagiPreferredNames)
        .values({ did, name: preferredName, source: "manual" })
        .onConflictDoUpdate({
          target: nagiPreferredNames.did,
          set: {
            name: sql`excluded.name`,
            // 本人が設定画面で入れた値は、会話からの自動検知より確かなので
            // source を manual に上書きする。model/prompt_version は判定由来の
            // 情報なので、手入力に変わった時点で消す。
            source: sql`excluded.source`,
            model: sql`null`,
            promptVersion: sql`null`,
            updatedAt: sql`now()`,
          },
        });
    }
  }

  if (replyFreq !== undefined) {
    await db
      .insert(followers)
      .values({ did, reply_freq: replyFreq })
      .onConflictDoUpdate({
        target: followers.did,
        set: {
          reply_freq: sql`excluded.reply_freq`,
          updated_at: sql`now()`,
        },
      });
  }

  if (feedTabsUpdatedAt) {
    // お気に入りと同じく、順序のある1本の配列なので updated_at による後勝ち。
    await db
      .insert(nagiFeedTabs)
      .values({ did, tabs: feedTabs, updatedAt: feedTabsUpdatedAt })
      .onConflictDoUpdate({
        target: nagiFeedTabs.did,
        set: {
          tabs: sql`excluded.tabs`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.updated_at > feed_tabs.updated_at`,
      });
  }

  if (languagePreferences && languagePreferencesUpdatedAt) {
    await db
      .insert(nagiLanguagePreferences)
      .values({
        did,
        postLanguage: languagePreferences.post,
        translationLanguage: languagePreferences.translation,
        translationProvider: languagePreferences.provider,
        autoTranslate: languagePreferences.autoTranslate,
        updatedAt: languagePreferencesUpdatedAt,
      })
      .onConflictDoUpdate({
        target: nagiLanguagePreferences.did,
        set: {
          postLanguage: sql`excluded.post_language`,
          translationLanguage: sql`excluded.translation_language`,
          translationProvider: sql`excluded.translation_provider`,
          autoTranslate: sql`excluded.auto_translate`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.updated_at > language_preferences.updated_at`,
      });
  }

  if (lastBookmarkFolderUpdatedAt) {
    if (lastBookmarkFolderId !== null) {
      const [owned] = await db
        .select({ id: nagiBookmarkFolders.id })
        .from(nagiBookmarkFolders)
        .where(
          sql`${nagiBookmarkFolders.id} = ${lastBookmarkFolderId} and ${nagiBookmarkFolders.ownerDid} = ${did}`,
        )
        .limit(1);
      if (!owned) invalid("lastBookmarkFolderId");
    }
    await db
      .insert(nagiBookmarkPreferences)
      .values({
        did,
        lastFolderId: lastBookmarkFolderId as string | null,
        updatedAt: lastBookmarkFolderUpdatedAt,
      })
      .onConflictDoUpdate({
        target: nagiBookmarkPreferences.did,
        set: {
          lastFolderId: sql`excluded.last_folder_id`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`excluded.updated_at > bookmark_preferences.updated_at`,
      });
  }

  // 送った値ではなくマージ後の確定値を返す。負けた端末はこれで自分側を直せる。
  return getPreferences(did);
}
