import {
  botSongSelectionCutoff,
  getRecentBotSongSelections,
  searchBotMemory,
  type BotMemorySearchResult,
} from "@bsky-affirmative-bot/database";
import type { LanguageName } from "@bsky-affirmative-bot/shared-configs";
import {
  searchYoutubeSong,
  type YoutubeSongMatch,
} from "../api/youtube/index.js";
import {
  MyMoodSongGenerator,
  type MoodSongCandidate,
} from "./generateMyMoodSong.js";

export interface MemorySongCandidate {
  documentId: number;
  title: string;
  artist: string;
}

type SongCandidate = MoodSongCandidate & { documentId?: number };

export interface GroundedMoodSong extends YoutubeSongMatch {
  documentId?: number;
  title: string;
  artist: string;
  comment: string;
  songKey: string;
}

const normalizeSongIdentityPart = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, "");

export const songKey = (song: Pick<MemorySongCandidate, "title" | "artist">) => {
  const title = normalizeSongIdentityPart(song.title);
  const artist = normalizeSongIdentityPart(song.artist);
  return title && artist ? `${title}\u0000${artist}` : "";
};

const cleanArtist = (value: string) => value
  .replace(/^(?:日本|海外|アメリカ|イギリス|韓国)の/u, "")
  .replace(/^(?:(?:女性|男性)?(?:シンガーソングライター|歌手|ロックバンド|バンド|音楽ユニット|アーティスト)(?:である)?)[・、\s]*/u, "")
  .replace(/[。、「」『』]+$/u, "")
  .trim();

/** 知識カード中に曲名と作者の関係が明記されたものだけを拾う。 */
export function extractMemorySongCandidates(
  rows: Pick<BotMemorySearchResult, "id" | "content">[],
): MemorySongCandidate[] {
  const candidates: MemorySongCandidate[] = [];
  const seen = new Set<string>();
  const patterns = [
    /[「『](?<title>[^」』\n]{1,100})[」』](?:（[^）\n]*）)?は、?(?<artist>[^。\n]{1,100}?)による楽曲(?:です|である)/gu,
    /[「『](?<title>[^」』\n]{1,100})[」』](?:（[^）\n]*）)?は、?(?<artist>[^。\n]{1,100}?)の(?:\d+枚目の)?シングル(?:です|である)/gu,
  ];

  for (const row of rows) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of row.content.matchAll(pattern)) {
        const title = match.groups?.title?.trim();
        const artist = cleanArtist(match.groups?.artist ?? "");
        if (!title || title.length > 100 || !artist || artist.length > 100) continue;
        const key = songKey({ title, artist });
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ documentId: row.id, title, artist });
      }
    }
  }
  return candidates;
}

export function buildMoodSongMemoryQuery(currentMood: string, langStr: LanguageName) {
  const musicTerms = langStr === "日本語"
    ? "実在する楽曲 曲名 アーティスト 音楽"
    : "real song title artist music track";
  return `${currentMood.trim()}\n${musicTerms}`.slice(0, 1_000);
}

export async function findMoodSongCandidates(
  currentMood: string,
  langStr: LanguageName,
  deps: { search?: typeof searchBotMemory } = {},
): Promise<MemorySongCandidate[]> {
  const rows = await (deps.search ?? searchBotMemory)({
    query: buildMoodSongMemoryQuery(currentMood, langStr),
    purpose: "scheduled_post",
    sources: ["web_research"],
    limit: 20,
  });
  return extractMemorySongCandidates(rows);
}

const generator = new MyMoodSongGenerator();

async function verifyCandidates(
  candidates: SongCandidate[],
  excludedSongKeys: ReadonlySet<string>,
  excludedVideoIds: ReadonlySet<string>,
  searchYoutube: typeof searchYoutubeSong,
) {
  for (const candidate of candidates.slice(0, 3)) {
    const key = songKey(candidate);
    if (!key || excludedSongKeys.has(key)) continue;
    const match = await searchYoutube(candidate.title, candidate.artist);
    if (!match || excludedVideoIds.has(match.videoId)) continue;
    return {
      ...candidate,
      ...match,
      songKey: key,
      comment: candidate.comment || "今の投稿に合いそうな曲を選んだよ！",
    } satisfies GroundedMoodSong;
  }
  return null;
}

/** Geminiで候補を作り、YouTubeで検証する。失敗時だけbot memoryへフォールバックする。 */
export async function resolveMoodSong(
  postText: string,
  langStr: LanguageName,
  deps: {
    generateCandidates?: MyMoodSongGenerator["generateCandidates"];
    findCandidates?: typeof findMoodSongCandidates;
    getRecentSelections?: typeof getRecentBotSongSelections;
    searchYoutube?: typeof searchYoutubeSong;
    excludeSongKeys?: ReadonlySet<string>;
    excludeVideoIds?: ReadonlySet<string>;
    now?: Date;
  } = {},
): Promise<GroundedMoodSong | null> {
  const getRecent = deps.getRecentSelections ?? getRecentBotSongSelections;
  const recent = await getRecent(botSongSelectionCutoff(deps.now));
  const excludedSongKeys = new Set([
    ...recent.map((item) => item.songKey),
    ...(deps.excludeSongKeys ?? []),
  ]);
  const excludedVideoIds = new Set([
    ...recent.map((item) => item.videoId),
    ...(deps.excludeVideoIds ?? []),
  ]);
  const history = recent.map(({ title, artist }) => ({ title, artist }));
  const searchYoutube = deps.searchYoutube ?? searchYoutubeSong;

  try {
    const generate = deps.generateCandidates ?? generator.generateCandidates.bind(generator);
    const generated = await generate(postText, langStr, history);
    const verified = await verifyCandidates(
      generated,
      excludedSongKeys,
      excludedVideoIds,
      searchYoutube,
    );
    if (verified) return verified;
  } catch (error) {
    console.error("[WARN][MOOD_SONG] Gemini candidate generation failed", error);
  }

  const memories = await (deps.findCandidates ?? findMoodSongCandidates)(postText, langStr);
  return verifyCandidates(
    memories.map((item) => ({
      ...item,
      comment: langStr === "日本語"
        ? "記憶に残っていた曲から、今の投稿に合いそうな一曲を選んだよ！"
        : "I picked a verified song from my memory that fits this post!",
    })),
    excludedSongKeys,
    excludedVideoIds,
    searchYoutube,
  );
}

/** DB反映までの短い隙間でも同一プロセス内の再選を避ける。 */
export class MoodSongResolver {
  private recent: GroundedMoodSong[] = [];

  constructor(private maxHistory = 30) {}

  async resolve(postText: string, langStr: LanguageName) {
    return resolveMoodSong(postText, langStr, {
      excludeSongKeys: new Set(this.recent.map((item) => item.songKey)),
      excludeVideoIds: new Set(this.recent.map((item) => item.videoId)),
    });
  }

  remember(song: GroundedMoodSong) {
    this.recent = [song, ...this.recent.filter((item) =>
      item.videoId !== song.videoId && item.songKey !== song.songKey
    )].slice(0, this.maxHistory);
  }
}
