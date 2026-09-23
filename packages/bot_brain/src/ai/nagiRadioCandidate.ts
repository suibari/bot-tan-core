import type { NagiRadioFact, NagiRadioSong } from "./generateNagiRadioComment.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** 制作情報の出典がなくても、確認できた動画の曲を放送候補として残す。 */
export async function selectNagiRadioCandidate(
  resolve: (attempt: number, excludedSongKeys: Set<string>, excludedVideoIds: Set<string>) => Promise<NagiRadioSong | null>,
  research: (song: NagiRadioSong) => Promise<NagiRadioFact | null>,
  attempts = 3,
): Promise<{ song: NagiRadioSong; fact: NagiRadioFact | null } | null> {
  const excludedSongKeys = new Set<string>();
  const excludedVideoIds = new Set<string>();
  let fallback: NagiRadioSong | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let candidate: NagiRadioSong | null;
    try {
      candidate = await resolve(attempt, excludedSongKeys, excludedVideoIds);
    } catch (error) {
      if (!fallback) throw error;
      console.warn("[WARN][NAGI][RADIO] Later song selection failed; keeping verified fallback", error);
      break;
    }
    if (!candidate) break;
    excludedSongKeys.add(candidate.songKey);
    excludedVideoIds.add(candidate.videoId);
    if (!VIDEO_ID.test(candidate.videoId)) continue;
    fallback ??= candidate;
    let fact: NagiRadioFact | null = null;
    try {
      fact = await research(candidate);
    } catch (error) {
      console.warn(`[WARN][NAGI][RADIO] Song research failed for ${candidate.artist} - ${candidate.title}`, error);
    }
    if (fact) return { song: candidate, fact };
  }
  return fallback ? { song: fallback, fact: null } : null;
}
