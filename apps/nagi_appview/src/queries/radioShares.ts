import { db, nagiRadioShares, nagiRadioTracks } from "@bsky-affirmative-bot/database";
import type { NagiRadio, RadioQuoteView } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { toRadioTrack } from "./radio.js";
import type { DbLike } from "./zenkatsu.js";

/**
 * botたんラジオの公開（com.suibari.nagi.radio）。
 *
 * レコードが持つのは「どの回か」だけで、曲とDJコメントは本人の radio_tracks から引く。
 * 他人の回は (作者DID, slotKey) で引けないので、レコードを書いてもbotたんのコメントを
 * 偽装できない。公開をやめたいときは本人がレコードを消す。
 */
export const RADIO_SLOT_KEY = /^\d{4}-\d{2}-\d{2}-(?:08|14|20)$/;

export type RadioShareRejection = "rkey_mismatch" | "invalid_slot" | "no_such_track";

type RadioTrackRow = typeof nagiRadioTracks.$inferSelect;
type RadioShareRow = typeof nagiRadioShares.$inferSelect;

export async function indexRadioShare(
  tx: DbLike,
  input: { uri: string; cid: string; did: string; rkey: string; record: NagiRadio },
): Promise<{ indexed: boolean; reason?: RadioShareRejection }> {
  const { record, did } = input;
  if (!RADIO_SLOT_KEY.test(record.slotKey)) return { indexed: false, reason: "invalid_slot" };
  // rkey を slotKey に固定し、同じ回の公開を何本も作らせない。
  if (input.rkey !== record.slotKey) return { indexed: false, reason: "rkey_mismatch" };
  const [track] = await tx
    .select({ slotKey: nagiRadioTracks.slotKey })
    .from(nagiRadioTracks)
    .where(and(
      eq(nagiRadioTracks.subjectDid, did),
      eq(nagiRadioTracks.slotKey, record.slotKey),
      eq(nagiRadioTracks.status, "ready"),
    ))
    .limit(1);
  if (!track) return { indexed: false, reason: "no_such_track" };
  await tx
    .insert(nagiRadioShares)
    .values({ uri: input.uri, cid: input.cid, did, slotKey: record.slotKey, deletedAt: null })
    .onConflictDoUpdate({
      target: nagiRadioShares.uri,
      set: { cid: input.cid, deletedAt: null },
    });
  return { indexed: true };
}

export async function removeRadioShare(tx: DbLike, uri: string): Promise<void> {
  await tx
    .update(nagiRadioShares)
    .set({ deletedAt: new Date() })
    .where(eq(nagiRadioShares.uri, uri));
}

/** 表示できない引用。中身は出さず、引用元の URI だけを返す。 */
const unavailableRadio = (ref: { uri: string; cid: string }): RadioQuoteView => ({
  uri: ref.uri,
  cid: ref.cid,
  slotKey: ref.uri.split("/")[4] ?? "",
  title: "",
  artist: "",
  publishedAt: "",
  unavailable: true,
});

/** 公開の宣言と放送から引用カードを作る。どちらかが欠けたら unavailable。 */
export function radioQuoteView(
  ref: { uri: string; cid: string },
  share: RadioShareRow | undefined,
  track: RadioTrackRow | undefined,
  mutedActors: readonly string[] = [],
): RadioQuoteView {
  if (!share || share.deletedAt || mutedActors.includes(share.did)) return unavailableRadio(ref);
  if (!track || track.subjectDid !== share.did || track.slotKey !== share.slotKey || track.status !== "ready")
    return unavailableRadio(ref);
  const view = toRadioTrack(track);
  if (!view) return unavailableRadio(ref);
  return {
    uri: ref.uri,
    cid: ref.cid,
    slotKey: view.slotKey,
    title: view.title,
    artist: view.artist,
    ...(view.commentJa ? { commentJa: view.commentJa } : {}),
    ...(view.commentEn ? { commentEn: view.commentEn } : {}),
    songUrl: view.songUrl,
    thumbnailUrl: view.thumbnailUrl,
    publishedAt: view.publishedAt,
  };
}

/** ポストが引用しているラジオ。キーは `${uri}|${cid}`（ニュースの引用と同じ形）。 */
export async function getRadioQuoteViews(
  refs: Array<{ uri: string; cid: string }>,
  mutedActors: readonly string[] = [],
): Promise<Map<string, RadioQuoteView>> {
  if (!refs.length) return new Map();
  const uris = [...new Set(refs.map((ref) => ref.uri))];
  const shares = await db
    .select()
    .from(nagiRadioShares)
    .where(and(inArray(nagiRadioShares.uri, uris), isNull(nagiRadioShares.deletedAt)));
  const tracks = shares.length
    ? await db
        .select()
        .from(nagiRadioTracks)
        .where(or(...shares.map((share) => and(
          eq(nagiRadioTracks.subjectDid, share.did),
          eq(nagiRadioTracks.slotKey, share.slotKey),
        ))))
    : [];
  const shareByUri = new Map(shares.map((share) => [share.uri, share]));
  const out = new Map<string, RadioQuoteView>();
  for (const ref of refs) {
    const share = shareByUri.get(ref.uri);
    const track = share
      ? tracks.find((row) => row.subjectDid === share.did && row.slotKey === share.slotKey)
      : undefined;
    out.set(`${ref.uri}|${ref.cid}`, radioQuoteView(ref, share, track, mutedActors));
  }
  return out;
}
