import {
  botSongSelectionCutoff,
  botSongSelectionScopeKey,
  getRecentBotSongSelections,
  reserveBotSongSelection,
  searchBotMemory,
  type BotMemorySearchResult,
  type BotSongReservation,
  type BotSongSelectionScope,
} from "@bsky-affirmative-bot/database";
import type { LanguageName } from "@bsky-affirmative-bot/shared-configs";
import {
  searchYoutubeSong,
  type YoutubeSongMatch,
} from "../api/youtube/index.js";
import { isOllamaConfigured } from "../ollamaChat.js";
import {
  resolveLastFmMoodSong,
  screenLastFmMoodSongCandidates,
} from "./lastFmMoodSong.js";
import { songIdentityKey } from "./songIdentity.js";

export interface MemorySongCandidate {
  documentId: number;
  title: string;
  artist: string;
}

type SongCandidate = {
  title: string;
  artist: string;
  comment: string;
  documentId?: number;
};

export interface GroundedMoodSong extends YoutubeSongMatch {
  documentId?: number;
  title: string;
  artist: string;
  comment: string;
  songKey: string;
  /** Last.fm由来の候補では、API利用条件に沿って出典リンクを併記する。 */
  lastFmUrl?: string;
  /** AnimeThemes で作品とのOP/ED関係を確認した候補。 */
  animeTheme?: { animeName: string; type: "OP" | "ED"; sequence: number | null; slug?: string };
}

export const songKey = songIdentityKey;

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

async function screenMemorySongCandidates(
  postText: string,
  langStr: LanguageName,
  candidates: SongCandidate[],
) {
  const pool = candidates.slice(0, 12).map((candidate, index) => ({
    ...candidate,
    lastFmUrl: "",
    rank: index + 1,
    tags: ["bot-memory"],
    weight: 1 / (index + 1),
  }));
  const assessment = await screenLastFmMoodSongCandidates(postText, pool, langStr);
  const allowed = new Set(assessment.allowedIndices);
  return candidates.filter((_, index) => allowed.has(index));
}

/** Last.fm候補を優先し、失敗時はローカル検査済みbot memoryだけへフォールバックする。 */
export async function resolveMoodSong(
  postText: string,
  langStr: LanguageName,
  scope: BotSongSelectionScope,
  deps: {
    findCandidates?: typeof findMoodSongCandidates;
    getRecentSelections?: typeof getRecentBotSongSelections;
    searchYoutube?: typeof searchYoutubeSong;
    excludeSongKeys?: ReadonlySet<string>;
    excludeVideoIds?: ReadonlySet<string>;
    now?: Date;
    resolveLastFm?: typeof resolveLastFmMoodSong;
    screenMemory?: typeof screenMemorySongCandidates;
    /** 長い投稿群は全件から作った要約を検索に使う。 */
    memoryQueryText?: string;
  } = {},
): Promise<GroundedMoodSong | null> {
  const getRecent = deps.getRecentSelections ?? getRecentBotSongSelections;
  const recent = await getRecent(scope, deps.now ?? new Date());
  const excludedSongKeys = new Set([
    ...recent.map((item) => item.songKey),
    ...(deps.excludeSongKeys ?? []),
  ]);
  const excludedVideoIds = new Set([
    ...recent.map((item) => item.videoId),
    ...(deps.excludeVideoIds ?? []),
  ]);
  const searchYoutube = deps.searchYoutube ?? searchYoutubeSong;

  if (deps.resolveLastFm || (process.env.LASTFM_API_KEY && isOllamaConfigured())) {
    try {
      const lastFm = await (deps.resolveLastFm ?? resolveLastFmMoodSong)(postText, langStr, {
        excludedSongKeys,
        excludedVideoIds,
        searchYoutube,
      });
      if (lastFm) return { ...lastFm, songKey: songKey(lastFm) };
    } catch (error) {
      console.error("[WARN][MOOD_SONG] Last.fm candidate selection failed", error);
    }
  }

  const memories = await (deps.findCandidates ?? findMoodSongCandidates)(
    deps.memoryQueryText ?? postText, langStr);
  const memoryCandidates = memories.map((item) => ({
    ...item,
    comment: langStr === "日本語"
      ? "記憶に残っていた曲から、今の投稿に合いそうな一曲を選んだよ！"
      : "I picked a verified song from my memory that fits this post!",
  }));
  let screenedMemories: SongCandidate[];
  try {
    screenedMemories = await (deps.screenMemory ?? screenMemorySongCandidates)(
      postText,
      langStr,
      memoryCandidates,
    );
  } catch (error) {
    console.warn("[WARN][MOOD_SONG] Local bot-memory song screening failed", error);
    return null;
  }
  return verifyCandidates(
    screenedMemories,
    excludedSongKeys,
    excludedVideoIds,
    searchYoutube,
  );
}

export interface ReservedMoodSong {
  song: GroundedMoodSong;
  reservation: BotSongReservation;
}

type RecentMoodSong = { song: GroundedMoodSong; selectedAt: Date };

/** DB予約に加え、同一プロセスでは直近履歴を再問い合わせ前にも除外する。 */
export class MoodSongResolver {
  private recent = new Map<string, RecentMoodSong[]>();

  constructor(
    private maxHistory = 30,
    private dependencies: {
      now?: () => Date;
      reserve?: typeof reserveBotSongSelection;
      resolve?: typeof resolveMoodSong;
    } = {},
  ) {}

  private currentTime() {
    return this.dependencies.now?.() ?? new Date();
  }

  private activeRecent(scope: BotSongSelectionScope, now: Date) {
    const scopeKey = botSongSelectionScopeKey(scope);
    const cutoff = botSongSelectionCutoff(now);
    const active = (this.recent.get(scopeKey) ?? []).filter((item) =>
      item.selectedAt >= cutoff && item.selectedAt <= now
    );
    this.recent.set(scopeKey, active);
    return active;
  }

  async resolve(
    postText: string,
    langStr: LanguageName,
    scope: BotSongSelectionScope,
  ) {
    const now = this.currentTime();
    const recent = this.activeRecent(scope, now);
    return (this.dependencies.resolve ?? resolveMoodSong)(postText, langStr, scope, {
      now,
      excludeSongKeys: new Set(recent.map((item) => item.song.songKey)),
      excludeVideoIds: new Set(recent.map((item) => item.song.videoId)),
    });
  }

  async resolveAndReserve(
    postText: string,
    langStr: LanguageName,
    scope: BotSongSelectionScope,
    maxAttempts = 3,
  ): Promise<ReservedMoodSong | null> {
    const reserve = this.dependencies.reserve ?? reserveBotSongSelection;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const song = await this.resolve(postText, langStr, scope);
      if (!song) return null;
      const reservation = await reserve({
        videoId: song.videoId,
        songKey: song.songKey,
        title: song.title,
        artist: song.artist,
        scope,
      }, { now: this.currentTime() });
      if (reservation) return { song, reservation };
    }
    return null;
  }

  remember(scope: BotSongSelectionScope, song: GroundedMoodSong, selectedAt = this.currentTime()) {
    const scopeKey = botSongSelectionScopeKey(scope);
    const recent = this.activeRecent(scope, selectedAt);
    this.recent.set(scopeKey, [{ song, selectedAt }, ...recent.filter((item) =>
      item.song.videoId !== song.videoId && item.song.songKey !== song.songKey
    )].slice(0, this.maxHistory));
  }
}
