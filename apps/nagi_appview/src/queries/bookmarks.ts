import {
  db,
  nagiBookmarkFolders,
  nagiBookmarkPreferences,
  nagiBookmarks,
  nagiDiaries,
  nagiNews,
  nagiNewsApprovals,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import {
  NAGI,
  type BookmarkFolderView,
  type BookmarkFoldersView,
  type BookmarkItemView,
  type BookmarkStateView,
  type BookmarkSubjectType,
  type BookmarksPage,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { parseRecordUri } from "../ingest/recordUri.js";
import { diaryView, fetchDiaryRows } from "./diaries.js";
import { getApprovedNewsViews } from "./positiveNews.js";
import {
  fetchPostRows,
  getBotActor,
  hydratePostViews,
  type PostRow,
} from "./timeline.js";

export const BOOKMARK_FOLDER_LIMIT = 100;
export const BOOKMARK_LIMIT = 10_000;
export const BOOKMARK_STATE_LIMIT = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateUuid = (value: string, field: string) => {
  if (!UUID_RE.test(value))
    throw new ApiError(400, "invalid_request", `${field} must be a UUID`);
};

export function normalizeBookmarkFolderName(value: unknown): string {
  if (typeof value !== "string")
    throw new ApiError(400, "invalid_request", "name is required");
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80)
    throw new ApiError(
      400,
      "invalid_request",
      "name must be between 1 and 80 characters",
    );
  return name;
}

export function bookmarkSubjectType(uri: unknown): BookmarkSubjectType {
  const parsed = parseRecordUri(uri);
  if (!parsed)
    throw new ApiError(400, "invalid_request", "subjectUri must be an AT URI");
  if (parsed.collection === NAGI.post) return "post";
  if (parsed.collection === NAGI.news) return "news";
  if (parsed.collection === NAGI.diary) return "diary";
  throw new ApiError(
    400,
    "invalid_request",
    "Only Nagi posts, news, and diaries can be bookmarked",
  );
}

type Executor = Pick<typeof db, "insert" | "select">;
async function ensureDefaultFolder(
  ownerDid: string,
  lang: "ja" | "en",
  executor: Executor = db,
) {
  await executor
    .insert(nagiBookmarkFolders)
    .values({
      ownerDid,
      name: lang === "en" ? "Bookmarks" : "ブックマーク",
      isDefault: true,
    })
    .onConflictDoNothing();
}

const folderView = (
  folder: typeof nagiBookmarkFolders.$inferSelect,
  bookmarkCount: number,
): BookmarkFolderView => ({
  id: folder.id,
  name: folder.name,
  isDefault: folder.isDefault,
  count: bookmarkCount,
  createdAt: folder.createdAt.toISOString(),
  updatedAt: folder.updatedAt.toISOString(),
});

export async function getBookmarkFolders(
  ownerDid: string,
  lang: "ja" | "en",
): Promise<BookmarkFoldersView> {
  await ensureDefaultFolder(ownerDid, lang);
  const [rows, preferenceRows] = await Promise.all([
    db
      .select({
        folder: nagiBookmarkFolders,
        bookmarkCount: count(nagiBookmarks.id),
      })
      .from(nagiBookmarkFolders)
      .leftJoin(
        nagiBookmarks,
        and(
          eq(nagiBookmarks.ownerDid, nagiBookmarkFolders.ownerDid),
          eq(nagiBookmarks.folderId, nagiBookmarkFolders.id),
        ),
      )
      .where(eq(nagiBookmarkFolders.ownerDid, ownerDid))
      .groupBy(nagiBookmarkFolders.ownerDid, nagiBookmarkFolders.id)
      .orderBy(
        desc(nagiBookmarkFolders.isDefault),
        nagiBookmarkFolders.createdAt,
      ),
    db
      .select()
      .from(nagiBookmarkPreferences)
      .where(eq(nagiBookmarkPreferences.did, ownerDid))
      .limit(1),
  ]);
  const preference = preferenceRows[0];
  return {
    folders: rows.map((row) =>
      folderView(row.folder, Number(row.bookmarkCount)),
    ),
    folderLimit: BOOKMARK_FOLDER_LIMIT,
    bookmarkLimit: BOOKMARK_LIMIT,
    ...(preference?.lastFolderId &&
    rows.some((row) => row.folder.id === preference.lastFolderId)
      ? { lastFolderId: preference.lastFolderId }
      : {}),
    ...(preference
      ? { lastFolderUpdatedAt: preference.updatedAt.toISOString() }
      : {}),
  };
}

export async function putBookmarkFolder(
  ownerDid: string,
  input: { id?: string; name: unknown; lang: "ja" | "en" },
): Promise<BookmarkFolderView> {
  const name = normalizeBookmarkFolderName(input.name);
  if (input.id) validateUuid(input.id, "id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerDid}))`);
    await ensureDefaultFolder(ownerDid, input.lang, tx);
    if (input.id) {
      const [updated] = await tx
        .update(nagiBookmarkFolders)
        .set({ name, updatedAt: new Date() })
        .where(
          and(
            eq(nagiBookmarkFolders.ownerDid, ownerDid),
            eq(nagiBookmarkFolders.id, input.id),
          ),
        )
        .returning();
      if (!updated)
        throw new ApiError(
          404,
          "bookmark_folder_not_found",
          "Folder not found",
        );
      const [result] = await tx
        .select({ value: count(nagiBookmarks.id) })
        .from(nagiBookmarks)
        .where(
          and(
            eq(nagiBookmarks.ownerDid, ownerDid),
            eq(nagiBookmarks.folderId, updated.id),
          ),
        );
      return folderView(updated, Number(result?.value ?? 0));
    }
    const [total] = await tx
      .select({ value: count(nagiBookmarkFolders.id) })
      .from(nagiBookmarkFolders)
      .where(eq(nagiBookmarkFolders.ownerDid, ownerDid));
    if (Number(total?.value ?? 0) >= BOOKMARK_FOLDER_LIMIT)
      throw new ApiError(
        409,
        "bookmark_folder_limit",
        `Bookmark folders are limited to ${BOOKMARK_FOLDER_LIMIT}`,
      );
    const [folder] = await tx
      .insert(nagiBookmarkFolders)
      .values({ ownerDid, name })
      .returning();
    return folderView(folder, 0);
  });
}

export async function deleteBookmarkFolder(ownerDid: string, id: string) {
  validateUuid(id, "id");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerDid}))`);
    const [folder] = await tx
      .select()
      .from(nagiBookmarkFolders)
      .where(
        and(
          eq(nagiBookmarkFolders.ownerDid, ownerDid),
          eq(nagiBookmarkFolders.id, id),
        ),
      )
      .limit(1);
    if (!folder)
      throw new ApiError(404, "bookmark_folder_not_found", "Folder not found");
    if (folder.isDefault)
      throw new ApiError(
        409,
        "default_bookmark_folder",
        "The default folder cannot be deleted",
      );
    await tx
      .delete(nagiBookmarkFolders)
      .where(
        and(
          eq(nagiBookmarkFolders.ownerDid, ownerDid),
          eq(nagiBookmarkFolders.id, id),
        ),
      );
    return { deleted: true as const };
  });
}

export async function getBookmarkStates(
  ownerDid: string,
  uris: unknown,
): Promise<{ states: BookmarkStateView[] }> {
  if (
    !Array.isArray(uris) ||
    uris.length > BOOKMARK_STATE_LIMIT ||
    uris.some((uri) => typeof uri !== "string")
  )
    throw new ApiError(
      400,
      "invalid_request",
      `uris must contain at most ${BOOKMARK_STATE_LIMIT} strings`,
    );
  const unique = [...new Set(uris as string[])];
  unique.forEach(bookmarkSubjectType);
  if (!unique.length) return { states: [] };
  const rows = await db
    .select()
    .from(nagiBookmarks)
    .where(
      and(
        eq(nagiBookmarks.ownerDid, ownerDid),
        inArray(nagiBookmarks.subjectUri, unique),
      ),
    );
  const byUri = new Map(rows.map((row) => [row.subjectUri, row]));
  return {
    states: unique.map((subjectUri) => {
      const row = byUri.get(subjectUri);
      return {
        subjectUri,
        ...(row
          ? { folderId: row.folderId, createdAt: row.createdAt.toISOString() }
          : {}),
      };
    }),
  };
}

async function visiblePostRows(
  rows: PostRow[],
  viewerDid: string,
): Promise<PostRow[]> {
  const live = rows.filter((row) => !row.post.deletedAt);
  const rootUris = [
    ...new Set(
      live.flatMap((row) =>
        row.post.replyRootUri ? [row.post.replyRootUri] : [],
      ),
    ),
  ];
  const roots = rootUris.length
    ? new Map(
        (
          await db
            .select({
              uri: nagiPosts.uri,
              did: nagiPosts.did,
              kossori: nagiPosts.kossori,
              deletedAt: nagiPosts.deletedAt,
            })
            .from(nagiPosts)
            .where(inArray(nagiPosts.uri, rootUris))
        ).map((root) => [root.uri, root]),
      )
    : new Map();
  return live.filter((row) => {
    if (!row.post.replyRootUri)
      return !row.post.kossori || row.post.did === viewerDid;
    const root = roots.get(row.post.replyRootUri);
    return Boolean(
      root && !root.deletedAt && (!root.kossori || root.did === viewerDid),
    );
  });
}

async function assertBookmarkable(
  ownerDid: string,
  subjectUri: string,
  type: BookmarkSubjectType,
) {
  if (type === "post") {
    if (
      (await visiblePostRows(await fetchPostRows([subjectUri]), ownerDid))
        .length
    )
      return;
  } else if (type === "news") {
    if (
      (await getApprovedNewsViews([subjectUri], "ja", ownerDid)).has(subjectUri)
    )
      return;
  } else {
    const [row] = await db
      .select({ uri: nagiDiaries.uri })
      .from(nagiDiaries)
      .where(eq(nagiDiaries.uri, subjectUri))
      .limit(1);
    if (row) return;
  }
  throw new ApiError(
    404,
    "bookmark_subject_not_found",
    "Bookmark subject is not available",
  );
}

export async function putBookmark(
  ownerDid: string,
  folderId: string,
  subjectUri: string,
): Promise<BookmarkStateView> {
  validateUuid(folderId, "folderId");
  const subjectType = bookmarkSubjectType(subjectUri);
  await assertBookmarkable(ownerDid, subjectUri, subjectType);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerDid}))`);
    const [folder] = await tx
      .select({ id: nagiBookmarkFolders.id })
      .from(nagiBookmarkFolders)
      .where(
        and(
          eq(nagiBookmarkFolders.ownerDid, ownerDid),
          eq(nagiBookmarkFolders.id, folderId),
        ),
      )
      .limit(1);
    if (!folder)
      throw new ApiError(404, "bookmark_folder_not_found", "Folder not found");
    const [existing] = await tx
      .select()
      .from(nagiBookmarks)
      .where(
        and(
          eq(nagiBookmarks.ownerDid, ownerDid),
          eq(nagiBookmarks.subjectUri, subjectUri),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .insert(nagiBookmarkPreferences)
        .values({
          did: ownerDid,
          lastFolderId: existing.folderId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: nagiBookmarkPreferences.did,
          set: { lastFolderId: existing.folderId, updatedAt: sql`now()` },
        });
      return {
        subjectUri,
        folderId: existing.folderId,
        createdAt: existing.createdAt.toISOString(),
      };
    }
    const [total] = await tx
      .select({ value: count(nagiBookmarks.id) })
      .from(nagiBookmarks)
      .where(eq(nagiBookmarks.ownerDid, ownerDid));
    if (Number(total?.value ?? 0) >= BOOKMARK_LIMIT)
      throw new ApiError(
        409,
        "bookmark_limit",
        `Bookmarks are limited to ${BOOKMARK_LIMIT}`,
      );
    const [created] = await tx
      .insert(nagiBookmarks)
      .values({ ownerDid, folderId, subjectUri, subjectType })
      .returning();
    await tx
      .insert(nagiBookmarkPreferences)
      .values({
        did: ownerDid,
        lastFolderId: created.folderId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: nagiBookmarkPreferences.did,
        set: { lastFolderId: created.folderId, updatedAt: sql`now()` },
      });
    return {
      subjectUri,
      folderId: created.folderId,
      createdAt: created.createdAt.toISOString(),
    };
  });
}

export async function deleteBookmark(ownerDid: string, subjectUri: string) {
  bookmarkSubjectType(subjectUri);
  await db
    .delete(nagiBookmarks)
    .where(
      and(
        eq(nagiBookmarks.ownerDid, ownerDid),
        eq(nagiBookmarks.subjectUri, subjectUri),
      ),
    );
  return { deleted: true as const };
}

const encodeBookmarkCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString(
    "base64url",
  );
const decodeBookmarkCursor = (cursor?: string): [Date, string] | undefined => {
  if (!cursor) return undefined;
  try {
    const [createdAt, id] = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    );
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || !UUID_RE.test(id)) return undefined;
    return [date, id];
  } catch {
    return undefined;
  }
};

export async function getBookmarks(opts: {
  ownerDid: string;
  folderId?: string;
  cursor?: string;
  limit: number;
  lang: "ja" | "en";
  q?: string;
}): Promise<BookmarksPage> {
  if (opts.folderId) validateUuid(opts.folderId, "folderId");
  const point = decodeBookmarkCursor(opts.cursor);
  if (opts.cursor && !point)
    throw new ApiError(400, "invalid_request", "Invalid cursor");
  const filters = [eq(nagiBookmarks.ownerDid, opts.ownerDid)];
  if (opts.folderId) filters.push(eq(nagiBookmarks.folderId, opts.folderId));
  if (point)
    filters.push(
      or(
        lt(nagiBookmarks.createdAt, point[0]),
        and(
          eq(nagiBookmarks.createdAt, point[0]),
          lt(nagiBookmarks.id, point[1]),
        ),
      )!,
    );
  const q = opts.q?.trim().slice(0, 200);
  if (q) {
    filters.push(sql`(
      (${nagiBookmarks.subjectType} = 'post' and exists (
        select 1 from ${nagiPosts}
        where ${nagiPosts.uri} = ${nagiBookmarks.subjectUri}
          and ${nagiPosts.deletedAt} is null
          and position(lower(${q}) in lower(${nagiPosts.text})) > 0
      )) or
      (${nagiBookmarks.subjectType} = 'news' and exists (
        select 1 from ${nagiNews}
        inner join ${nagiNewsApprovals}
          on ${nagiNewsApprovals.newsUri} = ${nagiNews.uri}
          and ${nagiNewsApprovals.newsCid} = ${nagiNews.cid}
        where ${nagiNews.uri} = ${nagiBookmarks.subjectUri}
          and ${nagiNews.deletedAt} is null
          and ${nagiNewsApprovals.status} = 'approved'
          and ${nagiNewsApprovals.hiddenAt} is null
          and position(lower(${q}) in lower(concat_ws(' ',
            ${nagiNews.titleJa}, ${nagiNewsApprovals.titleEn}, ${nagiNews.sourceName},
            ${nagiNewsApprovals.botCommentJa}, ${nagiNewsApprovals.botCommentEn}
          ))) > 0
      )) or
      (${nagiBookmarks.subjectType} = 'diary' and exists (
        select 1 from ${nagiDiaries}
        where ${nagiDiaries.uri} = ${nagiBookmarks.subjectUri}
          and position(lower(${q}) in lower(concat_ws(' ',
            ${nagiDiaries.text}, ${nagiDiaries.titleJa}, ${nagiDiaries.titleEn}, ${nagiDiaries.diaryDate}
          ))) > 0
      ))
    )`);
  }
  const rows = await db
    .select()
    .from(nagiBookmarks)
    .where(and(...filters))
    .orderBy(desc(nagiBookmarks.createdAt), desc(nagiBookmarks.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const postRows = await visiblePostRows(
    await fetchPostRows(
      page
        .filter((row) => row.subjectType === "post")
        .map((row) => row.subjectUri),
    ),
    opts.ownerDid,
  );
  const [postViews, newsViews, diaryRows, botActor] = await Promise.all([
    hydratePostViews(postRows, opts.ownerDid),
    getApprovedNewsViews(
      page
        .filter((row) => row.subjectType === "news")
        .map((row) => row.subjectUri),
      opts.lang,
      opts.ownerDid,
    ),
    fetchDiaryRows(
      page
        .filter((row) => row.subjectType === "diary")
        .map((row) => row.subjectUri),
    ),
    getBotActor(),
  ]);
  const posts = new Map(postViews.map((post) => [post.uri, post]));
  // 他人の日記もブックマークできるので、後からプライベートになった日記はここで伏せる。
  const diaries = new Map(
    diaryRows.map((row) => [row.uri, diaryView(row, opts.ownerDid)]),
  );
  const items: BookmarkItemView[] = page.map((row) => {
    const common = {
      id: row.id,
      folderId: row.folderId,
      subjectUri: row.subjectUri,
      createdAt: row.createdAt.toISOString(),
    };
    const post = posts.get(row.subjectUri);
    if (row.subjectType === "post" && post)
      return { ...common, content: { kind: "post", post } };
    const news = newsViews.get(row.subjectUri);
    if (row.subjectType === "news" && news)
      return { ...common, content: { kind: "news", news } };
    const diary = diaries.get(row.subjectUri);
    if (row.subjectType === "diary" && diary)
      return { ...common, content: { kind: "diary", diary } };
    return {
      ...common,
      content: {
        kind: "unavailable",
        subjectType: row.subjectType as BookmarkSubjectType,
        subjectUri: row.subjectUri,
      },
    };
  });
  const last = page.at(-1);
  return {
    items,
    botActor,
    hasMore: rows.length > opts.limit,
    cursor:
      rows.length > opts.limit && last
        ? encodeBookmarkCursor(last.createdAt, last.id)
        : undefined,
  };
}
