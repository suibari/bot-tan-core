import { db, MemoryService, nagiRadioTracks } from "@bsky-affirmative-bot/database";
import { currentRadioSlotKey } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq } from "drizzle-orm";

/** 投稿の活動窓と公開枠が両方有効なときだけ、本人へ現在曲を返す。 */
export async function getRadioTrack(viewerDid: string, now = new Date()) {
  const active = await MemoryService.hasNagiPostsSince(
    viewerDid,
    new Date(now.getTime() - 7 * 24 * 60 * 60_000),
  );
  if (!active) return {};
  const [row] = await db
    .select()
    .from(nagiRadioTracks)
    .where(and(
      eq(nagiRadioTracks.subjectDid, viewerDid),
      eq(nagiRadioTracks.slotKey, currentRadioSlotKey(now)),
      eq(nagiRadioTracks.status, "ready"),
    ))
    .limit(1);
  if (!row?.title || !row.artist || !row.comment || !row.videoId || !row.publishedAt)
    return {};
  return { track: {
    slotKey: row.slotKey,
    title: row.title,
    artist: row.artist,
    comment: row.comment,
    videoId: row.videoId,
    publishedAt: row.publishedAt.toISOString(),
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
  } };
}
