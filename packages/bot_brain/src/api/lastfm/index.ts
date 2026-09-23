import { withMoodSongApiCall } from "../moodSongRequest.js";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const TOP_TRACKS_CACHE_MS = 6 * 60 * 60 * 1_000;
const TRACK_INFO_CACHE_MS = 24 * 60 * 60 * 1_000;
const TRACK_SEARCH_CACHE_MS = 24 * 60 * 60 * 1_000;
const ARTIST_SEARCH_CACHE_MS = 24 * 60 * 60 * 1_000;
const ARTIST_TRACKS_CACHE_MS = 6 * 60 * 60 * 1_000;
const ARTIST_TAGS_CACHE_MS = 24 * 60 * 60 * 1_000;

type CacheEntry<T> = { expiresAt: number; value: T };
const topTracksCache = new Map<string, CacheEntry<LastFmTrack[]>>();
const trackInfoCache = new Map<string, CacheEntry<LastFmTrackInfo>>();
const trackSearchCache = new Map<string, CacheEntry<LastFmTrack[]>>();
const artistSearchCache = new Map<string, CacheEntry<LastFmArtist[]>>();
const artistTracksCache = new Map<string, CacheEntry<LastFmTrack[]>>();
const artistTagsCache = new Map<string, CacheEntry<string[]>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export interface LastFmTrack {
  title: string;
  artist: string;
  lastFmUrl: string;
  mbid?: string;
  rank: number;
}

export interface LastFmTrackInfo {
  listeners: number | null;
  summary: string;
  topTags: string[];
}

export interface LastFmArtist {
  name: string;
  lastFmUrl: string;
  mbid?: string;
}

interface LastFmTopTracksResponse {
  tracks?: {
    track?: Array<{
      name?: string;
      url?: string;
      mbid?: string;
      artist?: { name?: string };
      "@attr"?: { rank?: string };
    }>;
  };
  error?: number;
  message?: string;
}

export interface LastFmTopTracksOptions {
  apiKey?: string;
  limit?: number;
  page?: number;
  fetchImpl?: typeof fetch;
}

interface LastFmTrackSearchResponse {
  results?: {
    trackmatches?: {
      track?: Array<{
        name?: string;
        artist?: string;
        url?: string;
        mbid?: string;
      }>;
    };
  };
  error?: number;
  message?: string;
}

interface LastFmArtistSearchResponse {
  results?: {
    artistmatches?: {
      artist?: Array<{
        name?: string;
        url?: string;
        mbid?: string;
      }>;
    };
  };
  error?: number;
  message?: string;
}

interface LastFmArtistTopTracksResponse {
  toptracks?: {
    track?: Array<{
      name?: string;
      url?: string;
      mbid?: string;
      artist?: { name?: string };
      "@attr"?: { rank?: string };
    }>;
  };
  error?: number;
  message?: string;
}

/** アーティスト名をLast.fmの正規表記へ解決する。 */
export async function searchLastFmArtists(
  query: string,
  options: LastFmTopTracksOptions = {},
): Promise<LastFmArtist[]> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const limit = Math.min(30, Math.max(1, options.limit ?? 10));
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const cacheKey = `${normalizedQuery.toLocaleLowerCase()}\u0000${limit}`;
  if (!options.fetchImpl) {
    const hit = cached(artistSearchCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    method: "artist.search",
    artist: normalizedQuery,
    api_key: apiKey,
    format: "json",
    limit: String(limit),
  });
  const body = await withMoodSongApiCall("lastfm", "artist.search", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmArtistSearchResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
  const artists = (body.results?.artistmatches?.artist ?? []).flatMap((artist) => {
    const name = artist.name?.trim();
    if (!name) return [];
    return [{
      name,
      lastFmUrl: artist.url?.trim() ?? "",
      ...(artist.mbid?.trim() ? { mbid: artist.mbid.trim() } : {}),
    }];
  });
  if (!options.fetchImpl) {
    artistSearchCache.set(cacheKey, { expiresAt: Date.now() + ARTIST_SEARCH_CACHE_MS, value: artists });
  }
  return artists;
}

/** Last.fm上のアーティスト代表曲を取得する。 */
export async function getLastFmArtistTopTracks(
  artist: Pick<LastFmArtist, "name" | "mbid">,
  options: LastFmTopTracksOptions = {},
): Promise<LastFmTrack[]> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const page = Math.max(1, options.page ?? 1);
  const identity = artist.mbid?.trim() || artist.name.trim();
  if (!identity) return [];
  const cacheKey = `${identity.toLocaleLowerCase()}\u0000${limit}\u0000${page}`;
  if (!options.fetchImpl) {
    const hit = cached(artistTracksCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    method: "artist.getTopTracks",
    ...(artist.mbid?.trim() ? { mbid: artist.mbid.trim() } : { artist: artist.name.trim() }),
    autocorrect: "1",
    api_key: apiKey,
    format: "json",
    limit: String(limit),
    page: String(page),
  });
  const body = await withMoodSongApiCall("lastfm", "artist.getTopTracks", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmArtistTopTracksResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
  const tracks = (body.toptracks?.track ?? []).flatMap((track, index) => {
    const title = track.name?.trim();
    const trackArtist = track.artist?.name?.trim() || artist.name.trim();
    if (!title || !trackArtist) return [];
    const parsedRank = Number(track["@attr"]?.rank);
    return [{
      title,
      artist: trackArtist,
      lastFmUrl: track.url?.trim() ?? "",
      ...(track.mbid?.trim() ? { mbid: track.mbid.trim() } : {}),
      rank: Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : index + 1,
    }];
  });
  if (!options.fetchImpl) {
    artistTracksCache.set(cacheKey, { expiresAt: Date.now() + ARTIST_TRACKS_CACHE_MS, value: tracks });
  }
  return tracks;
}

/** AnimeThemes に歌手情報がない古い曲などを Last.fm の曲検索で補完する。 */
export async function searchLastFmTracks(
  query: string,
  options: LastFmTopTracksOptions = {},
): Promise<LastFmTrack[]> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const limit = Math.min(30, Math.max(1, options.limit ?? 10));
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const cacheKey = `${normalizedQuery.toLocaleLowerCase()}\u0000${limit}`;
  if (!options.fetchImpl) {
    const hit = cached(trackSearchCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    method: "track.search",
    track: normalizedQuery,
    api_key: apiKey,
    format: "json",
    limit: String(limit),
  });
  const body = await withMoodSongApiCall("lastfm", "track.search", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmTrackSearchResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
  const tracks = (body.results?.trackmatches?.track ?? []).flatMap((track, index) => {
    const title = track.name?.trim();
    const artist = track.artist?.trim();
    if (!title || !artist) return [];
    return [{
      title,
      artist,
      lastFmUrl: track.url?.trim() ?? "",
      ...(track.mbid?.trim() ? { mbid: track.mbid.trim() } : {}),
      rank: index + 1,
    }];
  });
  if (!options.fetchImpl) {
    trackSearchCache.set(cacheKey, { expiresAt: Date.now() + TRACK_SEARCH_CACHE_MS, value: tracks });
  }
  return tracks;
}

/** Last.fm の公開タグ順位を取得する。ユーザー認証は不要。 */
export async function getLastFmTopTracks(
  tag: string,
  options: LastFmTopTracksOptions = {},
): Promise<LastFmTrack[]> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const page = Math.max(1, options.page ?? 1);
  const cacheKey = `${tag.toLocaleLowerCase()}\u0000${limit}\u0000${page}`;
  if (!options.fetchImpl) {
    const hit = cached(topTracksCache, cacheKey);
    if (hit) return hit;
  }

  const params = new URLSearchParams({
    method: "tag.getTopTracks",
    tag,
    api_key: apiKey,
    format: "json",
    limit: String(limit),
    page: String(page),
  });
  const body = await withMoodSongApiCall("lastfm", "tag.getTopTracks", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmTopTracksResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);

  const tracks = (body.tracks?.track ?? []).flatMap((track, index) => {
    const title = track.name?.trim();
    const artist = track.artist?.name?.trim();
    if (!title || !artist) return [];
    const parsedRank = Number(track["@attr"]?.rank);
    return [{
      title,
      artist,
      lastFmUrl: track.url?.trim() ?? "",
      ...(track.mbid?.trim() ? { mbid: track.mbid.trim() } : {}),
      rank: Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : index + 1,
    }];
  });
  if (!options.fetchImpl) {
    topTracksCache.set(cacheKey, { expiresAt: Date.now() + TOP_TRACKS_CACHE_MS, value: tracks });
  }
  return tracks;
}

interface LastFmTrackInfoResponse {
  track?: {
    listeners?: string;
    wiki?: { summary?: string };
    toptags?: { tag?: Array<{ name?: string }> };
  };
  error?: number;
  message?: string;
}

const decodeBasicHtml = (value: string) => value
  .replace(/<a\b[^>]*>.*?<\/a>/giu, "")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&quot;/gu, '"')
  .replace(/&#39;/gu, "'")
  .replace(/&amp;/gu, "&")
  .replace(/\s+/gu, " ")
  .trim();

export async function getLastFmTrackInfo(
  title: string,
  artist: string,
  options: Pick<LastFmTopTracksOptions, "apiKey" | "fetchImpl"> = {},
): Promise<LastFmTrackInfo> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const cacheKey = `${artist.toLocaleLowerCase()}\u0000${title.toLocaleLowerCase()}`;
  if (!options.fetchImpl) {
    const hit = cached(trackInfoCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    method: "track.getInfo",
    track: title,
    artist,
    api_key: apiKey,
    format: "json",
    autocorrect: "1",
  });
  const body = await withMoodSongApiCall("lastfm", "track.getInfo", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmTrackInfoResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
  const listeners = Number(body.track?.listeners);
  const info = {
    listeners: Number.isFinite(listeners) && listeners >= 0 ? listeners : null,
    summary: decodeBasicHtml(body.track?.wiki?.summary ?? "").slice(0, 700),
    topTags: (body.track?.toptags?.tag ?? [])
      .flatMap((tag) => tag.name?.trim() ? [tag.name.trim()] : [])
      .slice(0, 10),
  };
  if (!options.fetchImpl) {
    trackInfoCache.set(cacheKey, { expiresAt: Date.now() + TRACK_INFO_CACHE_MS, value: info });
  }
  return info;
}

interface LastFmArtistInfoResponse {
  artist?: { tags?: { tag?: Array<{ name?: string }> } };
  error?: number;
  message?: string;
}

/** 曲の個別タグが少ない場合に、歌手の音楽傾向を安全判定へ渡す。 */
export async function getLastFmArtistTags(
  artist: string,
  options: Pick<LastFmTopTracksOptions, "apiKey" | "fetchImpl"> = {},
): Promise<string[]> {
  const apiKey = options.apiKey ?? process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is required");
  const name = artist.trim();
  if (!name) return [];
  const cacheKey = name.toLocaleLowerCase();
  if (!options.fetchImpl) {
    const hit = cached(artistTagsCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    method: "artist.getInfo",
    artist: name,
    api_key: apiKey,
    format: "json",
    autocorrect: "1",
  });
  const body = await withMoodSongApiCall("lastfm", "artist.getInfo", async (signal) => {
    const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
      headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
      signal,
    });
    if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
    return response.json() as Promise<LastFmArtistInfoResponse>;
  });
  if (body.error) throw new Error(`Last.fm API ${body.error}: ${body.message ?? "unknown error"}`);
  const tags = (body.artist?.tags?.tag ?? [])
    .flatMap((tag) => tag.name?.trim() ? [tag.name.trim()] : [])
    .slice(0, 8);
  if (!options.fetchImpl) {
    artistTagsCache.set(cacheKey, { expiresAt: Date.now() + ARTIST_TAGS_CACHE_MS, value: tags });
  }
  return tags;
}
