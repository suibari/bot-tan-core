const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const TOP_TRACKS_CACHE_MS = 6 * 60 * 60 * 1_000;
const TRACK_INFO_CACHE_MS = 24 * 60 * 60 * 1_000;
const TRACK_SEARCH_CACHE_MS = 24 * 60 * 60 * 1_000;

type CacheEntry<T> = { expiresAt: number; value: T };
const topTracksCache = new Map<string, CacheEntry<LastFmTrack[]>>();
const trackInfoCache = new Map<string, CacheEntry<LastFmTrackInfo>>();
const trackSearchCache = new Map<string, CacheEntry<LastFmTrack[]>>();

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
  const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
    headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
  const body = await response.json() as LastFmTrackSearchResponse;
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
  const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
    headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
  const body = await response.json() as LastFmTopTracksResponse;
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
  const response = await (options.fetchImpl ?? fetch)(`${LASTFM_API_URL}?${params}`, {
    headers: { "User-Agent": "bot-tan-core/lastfm-mood-song" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
  const body = await response.json() as LastFmTrackInfoResponse;
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
