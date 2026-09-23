import { and, desc, eq, gt, lt, lte } from "drizzle-orm";
import {
  bot_song_selections,
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
import { generateNagiRadioComment, researchNagiRadioSong, resolveMoodSong, searchYoutubeSong, selectNagiRadioCandidate, selectNagiRadioPostContext, type NagiRadioSong } from "@bsky-affirmative-bot/bot-brain";
import { getLangStr } from "@bsky-affirmative-bot/clients";
import { currentRadioSlotKey } from "@bsky-affirmative-bot/nagi-lexicon";
import { startWorkerLoop } from "./workerLoop.js";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 15 * 60_000;

export async function generateNagiRadioForUser(
  did: string,
  now = new Date(),
  options: { preferredSong?: NagiRadioSong } = {},
): Promise<boolean> {
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
    const [previous] = await db.select({ claimedAt: nagiRadioTracks.claimedAt })
      .from(nagiRadioTracks).where(and(eq(nagiRadioTracks.subjectDid, did),
        eq(nagiRadioTracks.status, "ready"), lt(nagiRadioTracks.slotKey, slotKey)))
      .orderBy(desc(nagiRadioTracks.slotKey)).limit(1);
    // 初回だけ過去7日。2回目以降は直前の成功した実行開始時刻から全件を見る。
    const since = previous?.claimedAt ?? new Date(now.getTime() - WEEK_MS);
    const posts = (await MemoryService.getNagiPostsSince(did, since))
      .filter((post) => post.text.trim() && post.recordCreatedAt.getTime() <= now.getTime() &&
        (!previous || post.recordCreatedAt.getTime() > since.getTime()));
    const recalled = posts.length ? null : await MemoryService.getRandomNagiRadioMemory(did);
    if (!posts.length && !recalled) return false;
    const latest = posts.at(-1);
    const latestLangs = [...posts].reverse().find((post) =>
      Array.isArray(post.langs) && post.langs.length)?.langs as string[] | undefined;
    const contextLangs = latestLangs?.length ? latestLangs : recalled?.langs;
    const detectLanguage = (text: string, langs?: string[]): "日本語" | "English" =>
      langs?.length ? (getLangStr(langs) === "日本語" ? "日本語" : "English")
        : (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ||
          (/[\p{Script=Han}]/u.test(text) && !/[a-z]/i.test(text)) ? "日本語" : "English");
    const initialLanguage = detectLanguage(latest?.text ?? recalled!.text, contextLangs);
    const context = posts.length
      ? await selectNagiRadioPostContext(posts.map((post) => post.text), initialLanguage)
      : null;
    const songText = context?.songContext ?? recalled!.text.slice(0, 3_400);
    const commentPost = context ? posts[context.commentPostIndex] : null;
    const language = commentPost ? detectLanguage(commentPost.text,
      Array.isArray(commentPost.langs) ? commentPost.langs as string[] : undefined) : initialLanguage;
    const scope = djSongSelectionScope(did);
    // 候補群を引き直しても同じ動画検索を繰り返さない。
    const youtubeCache = new Map<string, ReturnType<typeof searchYoutubeSong>>();
    const searchYoutube: typeof searchYoutubeSong = (title, artist, contextTerms) => {
      const key = JSON.stringify([title, artist, contextTerms ?? []]);
      const cached = youtubeCache.get(key);
      if (cached) return cached;
      const search = searchYoutubeSong(title, artist, contextTerms).catch((error) => {
        youtubeCache.delete(key);
        throw error;
      });
      youtubeCache.set(key, search);
      return search;
    };
    const selected = await selectNagiRadioCandidate(
      async (attempt, excludedSongKeys, excludedVideoIds) => {
        const candidate = attempt === 0 && options.preferredSong ? options.preferredSong : await resolveMoodSong(songText, language, scope, {
          excludeSongKeys: excludedSongKeys,
          excludeVideoIds: excludedVideoIds,
          memoryQueryText: context?.memoryQueryContext,
          searchYoutube,
        });
        if (candidate) console.info(`[INFO][NAGI][RADIO] Candidate ${attempt + 1} for ${did}: ${candidate.artist} - ${candidate.title}`);
        return candidate;
      },
      (candidate) => researchNagiRadioSong(candidate, language),
    );
    if (!selected) throw new Error("No eligible radio video after three selection attempts");
    const { song, fact } = selected;
    if (!fact) console.warn(`[WARN][NAGI][RADIO] Publishing without a song background fact for ${did} ${slotKey}`);
    const [actor, profile, preferred] = await Promise.all([
      db.select({ handle: nagiActors.handle }).from(nagiActors).where(eq(nagiActors.did, did)).limit(1),
      db.select({ displayName: nagiProfiles.displayName }).from(nagiProfiles).where(eq(nagiProfiles.did, did)).limit(1),
      db.select({ name: nagiPreferredNames.name }).from(nagiPreferredNames).where(eq(nagiPreferredNames.did, did)).limit(1),
    ]);
    const comment = await generateNagiRadioComment({
      did, name: preferred[0]?.name || profile[0]?.displayName || actor[0]?.handle || null,
      slotKey, posts: commentPost ? [context!.commentPostText] : [],
      memory: recalled ? [recalled.text] : [],
      hasPrivatePost: commentPost?.kossori ?? recalled?.kossori ?? false,
      language, song, fact,
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
        sourceUrl: fact?.sourceUrl ?? null, publishedAt: new Date(),
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
  const dids = await MemoryService.getNagiRadioAudience();
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
