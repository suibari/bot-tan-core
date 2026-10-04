import type { LanguageName } from "@bsky-affirmative-bot/shared-configs";
import { getRecentBotSongSelections, type BotSongSelectionScope } from "@bsky-affirmative-bot/database";
import { getLastFmTrackInfo, lastFmSongUrl, type LastFmTrackInfo } from "../api/lastfm/index.js";
import {
  buildLastFmMoodSongComment,
  discoverLastFmMoodSongCandidates,
  type MoodSongInput,
  type SongSelectionBasis,
} from "./lastFmMoodSong.js";
import { songIdentityKey, songIdentityPart } from "./songIdentity.js";
import type { NagiRadioSong } from "./generateNagiRadioComment.js";

type SongCard = Pick<LinkedMoodSong, "title" | "artist" | "songKey" | "songUrl" | "thumbnailUrl">;

/** ムード枠から外す期間。 */
const AVOID_RECENT_ARTIST_MS = 7 * 24 * 60 * 60 * 1_000;
/** 歌手指定の経路を後回しにする、直近の選曲数。 */
const DEMOTE_RECENT_ARTIST_COUNT = 3;

/** 同じスコープで直近に選んだアーティスト。履歴は新しい順で来る。 */
export function recentArtistSets(
  recent: ReadonlyArray<{ artist: string; selectedAt: Date }>,
  now = new Date(),
) {
  const key = (artist: string) => songIdentityPart(artist);
  return {
    avoid: new Set(recent
      .filter((song) => now.getTime() - song.selectedAt.getTime() <= AVOID_RECENT_ARTIST_MS)
      .map((song) => key(song.artist)).filter(Boolean)),
    demote: new Set(recent.slice(0, DEMOTE_RECENT_ARTIST_COUNT).map((song) => key(song.artist)).filter(Boolean)),
  };
}

/** ジャケットと曲ページの両方が確認できた曲だけを渡す。 */
function songCard(title: string, artist: string, info: LastFmTrackInfo): SongCard | null {
  const songUrl = lastFmSongUrl(info.lastFmUrl);
  if (!songUrl || !info.thumbnailUrl) return null;
  const identity = { title: info.title || title, artist: info.artist || artist };
  return { ...identity, songKey: songIdentityKey(identity), songUrl, thumbnailUrl: info.thumbnailUrl };
}

export async function resolveNagiRadioSongLink(
  title: string, artist: string,
  trackInfo: typeof getLastFmTrackInfo = getLastFmTrackInfo,
): Promise<NagiRadioSong | null> {
  return songCard(title, artist, await trackInfo(title, artist));
}

/** DJとラジオ用の曲リンク。YouTubeの検索枠・動画の有無には依存しない。 */
export async function resolveLinkedMoodSong(
  input: MoodSongInput,
  language: LanguageName,
  scope: BotSongSelectionScope,
  deps: {
    discover?: typeof discoverLastFmMoodSongCandidates;
    getRecentSelections?: typeof getRecentBotSongSelections;
    trackInfo?: typeof getLastFmTrackInfo;
    excludeSongKeys?: ReadonlySet<string>;
    now?: Date;
    comment?: typeof buildLastFmMoodSongComment;
    /** 本人の関心から引いた曲ジャンル（`interestMusicTags`）。 */
    interestMusicTags?: readonly string[];
    /** request の歌手指定も直近3回なら後回しにする（ラジオ用）。 */
    demoteRequestArtist?: boolean;
  } = {},
): Promise<LinkedMoodSong | null> {
  const recent = await (deps.getRecentSelections ?? getRecentBotSongSelections)(scope, deps.now);
  const excludedSongKeys = new Set([...recent.map((song) => song.songKey), ...(deps.excludeSongKeys ?? [])]);
  const { allowed, contextualPostText } = await (deps.discover ?? discoverLastFmMoodSongCandidates)(input, language, {
    excludedSongKeys,
    interestMusicTags: deps.interestMusicTags,
    recentArtists: { ...recentArtistSets(recent, deps.now), demoteRequest: deps.demoteRequestArtist },
  });
  for (const candidate of allowed) {
    if (excludedSongKeys.has(songIdentityKey(candidate))) continue;
    try {
      // 通常は選曲時のtrack.getInfoを再利用。追加された候補だけ補完する。
      const info = candidate.info ?? await (deps.trackInfo ?? getLastFmTrackInfo)(candidate.title, candidate.artist);
      const card = songCard(candidate.title, candidate.artist, info);
      if (!card || excludedSongKeys.has(card.songKey)) continue;
      const comment = await (deps.comment ?? buildLastFmMoodSongComment)(contextualPostText, language, { ...candidate, title: card.title, artist: card.artist });
      return { ...card, url: card.songUrl, lastFmUrl: card.songUrl, comment,
        ...(candidate.animeTheme ? { animeTheme: candidate.animeTheme } : {}),
        ...(candidate.selectionBasis ? { selectionBasis: candidate.selectionBasis } : {}) };
    } catch (error) {
      console.warn("[WARN][MOOD_SONG] Last.fm song card lookup failed", error);
    }
  }
  return null;
}

export interface LinkedMoodSong extends NagiRadioSong {
  songUrl: string;
  thumbnailUrl: string;
  url: string;
  lastFmUrl: string;
  comment: string;
  selectionBasis?: SongSelectionBasis;
}

/**
 * ラジオ本文は専用の生成処理が担うので、DJ用コメントを二重生成しない。
 * ラジオの request は本人の投稿・記憶の要約で依頼ではないので、歌手指定も後回しの対象にする。
 */
export function resolveNagiRadioSong(
  input: MoodSongInput, language: LanguageName, scope: BotSongSelectionScope,
  deps: Parameters<typeof resolveLinkedMoodSong>[3] = {},
): Promise<LinkedMoodSong | null> {
  return resolveLinkedMoodSong(input, language, scope, { demoteRequestArtist: true, ...deps, comment: async () => "" });
}
