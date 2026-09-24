import { db, nagiRadioReadStates, nagiRadioTracks } from "@bsky-affirmative-bot/database";
import { currentRadioSlotKey } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

type RadioRow = typeof nagiRadioTracks.$inferSelect;
const SLOT_KEY = /^\d{4}-\d{2}-\d{2}-(?:08|14|20)$/;

export function toRadioTrack(row: RadioRow) {
  const songUrl = row.songUrl || (row.videoId ? `https://www.youtube.com/watch?v=${row.videoId}` : null);
  const thumbnailUrl = row.thumbnailUrl || (row.videoId ? `https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg` : null);
  const comment = row.commentJa || row.commentEn;
  if (!row.title || !row.artist || !comment || !songUrl || !thumbnailUrl || !row.publishedAt)
    return null;
  return {
    slotKey: row.slotKey,
    title: row.title,
    artist: row.artist,
    // 旧クライアントとの互換用。DBにはja/enだけを保存する。
    comment,
    ...(row.commentJa ? { commentJa: row.commentJa } : {}),
    ...(row.commentEn ? { commentEn: row.commentEn } : {}),
    songUrl,
    thumbnailUrl,
    ...(row.videoId ? { videoId: row.videoId } : {}),
    publishedAt: row.publishedAt.toISOString(),
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
  };
}

async function latestReadySlot(viewerDid: string): Promise<string | undefined> {
  const [row] = await db.select({ slotKey: nagiRadioTracks.slotKey })
    .from(nagiRadioTracks)
    .where(and(eq(nagiRadioTracks.subjectDid, viewerDid), eq(nagiRadioTracks.status, "ready")))
    .orderBy(desc(nagiRadioTracks.slotKey)).limit(1);
  return row?.slotKey;
}

export function unreadRadioSlot(latest: string | undefined, seen: string | undefined) {
  return latest && latest > (seen ?? "") ? latest : undefined;
}

/** 現在枠の曲はサイドバー用。未読は履歴全体の最新枠から判定する。 */
export async function getRadioTrack(viewerDid: string, now = new Date()) {
  const [rows, latest, seen] = await Promise.all([
    db.select().from(nagiRadioTracks).where(and(
      eq(nagiRadioTracks.subjectDid, viewerDid),
      eq(nagiRadioTracks.slotKey, currentRadioSlotKey(now)),
      eq(nagiRadioTracks.status, "ready"),
    )).limit(1),
    latestReadySlot(viewerDid),
    db.select({ slotKey: nagiRadioReadStates.lastSeenSlotKey })
      .from(nagiRadioReadStates).where(eq(nagiRadioReadStates.subjectDid, viewerDid)).limit(1),
  ]);
  const track = rows[0] ? toRadioTrack(rows[0]) : null;
  const unreadSlotKey = unreadRadioSlot(latest, seen[0]?.slotKey);
  return {
    ...(track ? { track } : {}),
    hasUnread: Boolean(unreadSlotKey),
    ...(unreadSlotKey ? { unreadSlotKey } : {}),
  };
}

/** 本人の放送履歴。枠キーの降順で安定したカーソルページングを行う。 */
export async function getRadioHistory(
  viewerDid: string,
  options: { cursor?: string; limit?: number } = {},
) {
  if (options.cursor && !SLOT_KEY.test(options.cursor))
    throw new ApiError(400, "invalid_request", "Invalid radio cursor");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 30))
    throw new ApiError(400, "invalid_request", "Invalid radio limit");
  const pageSize = Math.min(30, Math.max(1, Math.trunc(options.limit ?? 20)));
  const [rows, latest, seen] = await Promise.all([
    db.select().from(nagiRadioTracks).where(and(
      eq(nagiRadioTracks.subjectDid, viewerDid),
      eq(nagiRadioTracks.status, "ready"),
      options.cursor ? lt(nagiRadioTracks.slotKey, options.cursor) : undefined,
    )).orderBy(desc(nagiRadioTracks.slotKey)).limit(pageSize + 1),
    latestReadySlot(viewerDid),
    db.select({ slotKey: nagiRadioReadStates.lastSeenSlotKey })
      .from(nagiRadioReadStates).where(eq(nagiRadioReadStates.subjectDid, viewerDid)).limit(1),
  ]);
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  return {
    tracks: pageRows.flatMap((row) => {
      const track = toRadioTrack(row);
      return track ? [track] : [];
    }),
    ...(!options.cursor && unreadRadioSlot(latest, seen[0]?.slotKey)
      ? { unreadSlotKey: unreadRadioSlot(latest, seen[0]?.slotKey) }
      : {}),
    ...(hasMore ? { cursor: pageRows.at(-1)!.slotKey } : {}),
  };
}

/** 実際に画面へ表示した本人の枠だけを既読にする。古い要求では既読位置を戻さない。 */
export async function markRadioSeen(viewerDid: string, slotKey: string) {
  if (!SLOT_KEY.test(slotKey))
    throw new ApiError(400, "invalid_request", "Invalid radio slot");
  const [owned] = await db.select({ slotKey: nagiRadioTracks.slotKey })
    .from(nagiRadioTracks).where(and(
      eq(nagiRadioTracks.subjectDid, viewerDid),
      eq(nagiRadioTracks.slotKey, slotKey),
      eq(nagiRadioTracks.status, "ready"),
    )).limit(1);
  if (!owned) throw new ApiError(404, "not_found", "Radio track not found");
  const [row] = await db.insert(nagiRadioReadStates)
    .values({ subjectDid: viewerDid, lastSeenSlotKey: slotKey })
    .onConflictDoUpdate({
      target: nagiRadioReadStates.subjectDid,
      set: { lastSeenSlotKey: sql`GREATEST(${nagiRadioReadStates.lastSeenSlotKey}, ${slotKey})` },
    }).returning({ slotKey: nagiRadioReadStates.lastSeenSlotKey });
  return { lastSeenSlotKey: row!.slotKey };
}
