import { and, eq, gt, lte } from "drizzle-orm";
import {
  bot_song_selections,
  buildMemoryContext,
  db,
  djSongSelectionScope,
  MemoryService,
  nagiActors,
  nagiPreferredNames,
  nagiProfiles,
  nagiRadioTracks,
  releaseBotSongSelection,
  reserveBotSongSelection,
  type BotSongReservation,
} from "@bsky-affirmative-bot/database";
import { generateNagiRadioComment, researchNagiRadioSong, resolveMoodSong, type NagiRadioSong } from "@bsky-affirmative-bot/bot-brain";
import { getLangStr } from "@bsky-affirmative-bot/clients";
import { currentRadioSlotKey } from "@bsky-affirmative-bot/nagi-lexicon";
import { startWorkerLoop } from "./workerLoop.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 15 * 60_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export async function generateNagiRadioForUser(did: string, now = new Date()): Promise<boolean> {
  const slotKey = currentRadioSlotKey(now);
  const stale = new Date(now.getTime() - LEASE_MS);
  const [claim] = await db.insert(nagiRadioTracks).values({
    subjectDid: did, slotKey, status: "pending", claimedAt: now,
  }).onConflictDoUpdate({
    target: [nagiRadioTracks.subjectDid, nagiRadioTracks.slotKey],
    set: {
      status: "pending", claimedAt: now,
      title: null, artist: null, comment: null, videoId: null,
      videoTitle: null, sourceUrl: null, publishedAt: null,
    },
    setWhere: and(eq(nagiRadioTracks.status, "pending"), lte(nagiRadioTracks.claimedAt, stale)),
  }).returning({ subjectDid: nagiRadioTracks.subjectDid });
  if (!claim) return false;

  let reservation: BotSongReservation | null = null;
  try {
    const posts = (await MemoryService.getNagiPostsSince(did, new Date(now.getTime() - WEEK_MS)))
      .filter((post) => post.text.trim()).slice(-8);
    if (!posts.length) return false;
    const latest = posts.at(-1)!;
    const latestLangs = [...posts].reverse().find((post) =>
      Array.isArray(post.langs) && post.langs.length)?.langs as string[] | undefined;
    const language = latestLangs?.length
      ? (getLangStr(latestLangs) === "日本語" ? "日本語" : "English")
      : (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(latest.text) ? "日本語" : "English");
    const postText = posts.slice(-3).map((post) => post.text.slice(0, 1_000)).join("\n");
    const scope = djSongSelectionScope(did);
    const excludedSongKeys = new Set<string>();
    const excludedVideoIds = new Set<string>();
    let song: NagiRadioSong | null = null;
    let fact: Awaited<ReturnType<typeof researchNagiRadioSong>> = null;
    // 検索結果が薄い曲だけを理由に枠全体を欠測させない。候補を最大3曲まで試す。
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await resolveMoodSong(postText, language, scope, {
        excludeSongKeys: excludedSongKeys,
        excludeVideoIds: excludedVideoIds,
      });
      if (!candidate || !VIDEO_ID.test(candidate.videoId)) break;
      console.info(`[INFO][NAGI][RADIO] Candidate ${attempt + 1} for ${did}: ${candidate.artist} - ${candidate.title}`);
      excludedSongKeys.add(candidate.songKey);
      excludedVideoIds.add(candidate.videoId);
      const sourced = await researchNagiRadioSong(candidate, language).catch((error) => {
        console.warn(`[WARN][NAGI][RADIO] Song research failed for ${candidate.artist} - ${candidate.title}`, error);
        return null;
      });
      if (sourced) { song = candidate; fact = sourced; break; }
      console.info(`[INFO][NAGI][RADIO] No supported fact for ${candidate.artist} - ${candidate.title}`);
    }
    if (!song || !fact) throw new Error("No sourced radio song among three candidates");
    const [actor, profile, preferred, memory] = await Promise.all([
      db.select({ handle: nagiActors.handle }).from(nagiActors).where(eq(nagiActors.did, did)).limit(1),
      db.select({ displayName: nagiProfiles.displayName }).from(nagiProfiles).where(eq(nagiProfiles.did, did)).limit(1),
      db.select({ name: nagiPreferredNames.name }).from(nagiPreferredNames).where(eq(nagiPreferredNames.did, did)).limit(1),
      buildMemoryContext({
        query: latest.text.slice(0, 1_000), purpose: "reply_history", subjectKey: did,
        kossoriSubjectKey: did, limit: 6, researchLimit: 0, digestDays: 0,
      }).catch(() => ({ own: [], related: [] })),
    ]);
    const ownMemory = [...memory.own, ...memory.related]
      .filter((row) => row.authorId === did).slice(0, 3).map((row) => row.content);
    const comment = await generateNagiRadioComment({
      did, name: preferred[0]?.name || profile[0]?.displayName || actor[0]?.handle || null,
      slotKey, posts: posts.map((post) => post.text), memory: ownMemory,
      hasPrivatePost: posts.some((post) => post.kossori), language, song, fact,
    });
    reservation = await reserveBotSongSelection({
      videoId: song.videoId, songKey: song.songKey,
      title: song.title, artist: song.artist, scope,
    });
    if (!reservation) throw new Error("Radio song already selected during generation");
    const held = reservation;
    await db.transaction(async (tx) => {
      const [published] = await tx.update(nagiRadioTracks).set({
        status: "ready", title: song.title, artist: song.artist, comment,
        videoId: song.videoId, videoTitle: song.videoTitle,
        sourceUrl: fact.sourceUrl, publishedAt: new Date(),
      }).where(and(eq(nagiRadioTracks.subjectDid, did), eq(nagiRadioTracks.slotKey, slotKey),
        eq(nagiRadioTracks.status, "pending"), eq(nagiRadioTracks.claimedAt, now)))
        .returning({ subjectDid: nagiRadioTracks.subjectDid });
      if (!published) throw new Error("Radio slot claim was lost before publishing");
      const [selected] = await tx.update(bot_song_selections).set({
        status: "published", reservation_expires_at: null, output_ref: slotKey,
      }).where(and(eq(bot_song_selections.id, held.id),
        eq(bot_song_selections.status, "reserved"),
        gt(bot_song_selections.reservation_expires_at, new Date())))
        .returning({ id: bot_song_selections.id });
      if (!selected) throw new Error("Radio song reservation expired before publishing");
    });
    reservation = null;
    return true;
  } catch (error) {
    if (reservation) await releaseBotSongSelection(reservation).catch((releaseError) =>
      console.error(`[ERROR][NAGI][RADIO] Failed to release reservation for ${did}`, releaseError));
    console.error(`[ERROR][NAGI][RADIO] Failed for ${did} ${slotKey}:`, error);
    // リース期限後に同じ枠を再試行する。途中の出力を公開しない。
    return false;
  }
}

export async function updateNagiRadio(now = new Date()): Promise<void> {
  const slotKey = currentRadioSlotKey(now);
  const dids = await MemoryService.getNagiActiveAuthorsSince(new Date(now.getTime() - WEEK_MS));
  // 1件ずつでは利用者数に比例して放送枠が遅れる。ローカル推論への負荷を抑えつつ2並列で進める。
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, dids.length) }, async () => {
    while (cursor < dids.length) {
      if (currentRadioSlotKey(new Date()) !== slotKey) return;
      const did = dids[cursor++];
      await generateNagiRadioForUser(did, new Date());
    }
  }));
}

export function startNagiRadioWorker() {
  const timer = startWorkerLoop({
    name: "NAGI_RADIO", intervalMs: 5 * 60_000, tick: updateNagiRadio, immediate: true,
  });
  timer.unref();
  return timer;
}
