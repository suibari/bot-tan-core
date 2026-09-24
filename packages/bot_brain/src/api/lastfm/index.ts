import { requestLastFm } from "./request.js";

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
  title?: string;
  artist?: string;
  lastFmUrl?: string;
  thumbnailUrl?: string;
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
  const body = await requestLastFm<LastFmArtistSearchResponse>(params, options.fetchImpl);
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
  const body = await requestLastFm<LastFmArtistTopTracksResponse>(params, options.fetchImpl);
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
  const body = await requestLastFm<LastFmTrackSearchResponse>(params, options.fetchImpl);
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
  const body = await requestLastFm<LastFmTopTracksResponse>(params, options.fetchImpl);

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
    name?: string;
    url?: string;
    artist?: { name?: string };
    album?: { image?: Array<{ "#text"?: string; size?: string }> };
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

/** APIが返した曲ページだけをリンクに使う。推測でURLを組み立てない。 */
export function lastFmSongUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) ||
      !["www.last.fm", "last.fm"].includes(url.hostname) || url.username || url.password || url.port ||
      !/^\/music\/[^/]+\/_\/[^/]+\/?$/.test(url.pathname)) return undefined;
    url.protocol = "https:";
    return url.href;
  } catch { return undefined; }
}

export function lastFmAlbumImage(images: Array<{ "#text"?: string; size?: string }> = []): string | undefined {
  const sizes = ["mega", "extralarge", "large", "medium", "small"];
  for (const size of sizes) {
    for (const image of images.filter((entry) => entry.size === size)) {
      try {
        const url = new URL(image["#text"] ?? "");
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["lastfm-img.freetls.fastly.net", "lastfm.freetls.fastly.net"].includes(url.hostname) ||
          /2a96cbd8b46e442fc41c2b86b821562f/i.test(url.pathname)) continue;
        return url.href;
      } catch { /* 空画像や不正URLは採用しない。 */ }
    }
  }
  return undefined;
}

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
  const body = await requestLastFm<LastFmTrackInfoResponse>(params, options.fetchImpl);
  const listeners = Number(body.track?.listeners);
  const lastFmUrl = lastFmSongUrl(body.track?.url);
  const thumbnailUrl = lastFmAlbumImage(body.track?.album?.image);
  const info = {
    ...(body.track?.name?.trim() ? { title: body.track.name.trim() } : {}),
    ...(body.track?.artist?.name?.trim() ? { artist: body.track.artist.name.trim() } : {}),
    ...(lastFmUrl ? { lastFmUrl } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
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
  const body = await requestLastFm<LastFmArtistInfoResponse>(params, options.fetchImpl);
  const tags = (body.artist?.tags?.tag ?? [])
    .flatMap((tag) => tag.name?.trim() ? [tag.name.trim()] : [])
    .slice(0, 8);
  if (!options.fetchImpl) {
    artistTagsCache.set(cacheKey, { expiresAt: Date.now() + ARTIST_TAGS_CACHE_MS, value: tags });
  }
  return tags;
}
