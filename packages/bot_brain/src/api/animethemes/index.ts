import { withMoodSongApiCall } from "../moodSongRequest.js";

const ANIME_THEMES_API_URL = "https://api.animethemes.moe";
const CACHE_MS = 24 * 60 * 60 * 1_000;

type CacheEntry<T> = { expiresAt: number; value: T };
const searchCache = new Map<string, CacheEntry<AnimeThemeAnime[]>>();
const themesCache = new Map<string, CacheEntry<AnimeThemeSong[]>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export interface AnimeThemeAnime {
  id: number;
  name: string;
  slug: string;
  year: number | null;
}

export interface AnimeThemeSong {
  animeName: string;
  animeSlug?: string;
  type: "OP" | "ED";
  sequence: number | null;
  title: string;
  artists: string[];
}

interface SearchResponse {
  search?: {
    anime?: Array<{
      id?: number;
      name?: string;
      slug?: string;
      year?: number | null;
    }>;
  };
}

interface AnimeResponse {
  anime?: Array<{
    name?: string;
    slug?: string;
    animethemes?: Array<{
      type?: string;
      sequence?: number | null;
      song?: {
        title?: string;
        artists?: Array<{ name?: string }>;
      };
    }>;
  }>;
}

async function fetchJson<T>(url: string, operation: string, fetchImpl: typeof fetch): Promise<T> {
  return withMoodSongApiCall("animethemes", operation, async (signal) => {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "bot-tan-core/anime-theme-song",
      },
      signal,
    });
    if (!response.ok) throw new Error(`AnimeThemes HTTP ${response.status}`);
    return response.json() as Promise<T>;
  });
}

/** AnimeThemes の検索インデックスから作品候補を取得する。 */
export async function searchAnimeThemes(
  query: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AnimeThemeAnime[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const cacheKey = normalizedQuery.toLocaleLowerCase();
  if (!options.fetchImpl) {
    const hit = cached(searchCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({ q: normalizedQuery });
  const body = await fetchJson<SearchResponse>(
    `${ANIME_THEMES_API_URL}/search?${params}`,
    "search",
    options.fetchImpl ?? fetch,
  );
  const anime = (body.search?.anime ?? []).flatMap((item) => {
    const name = item.name?.trim();
    const slug = item.slug?.trim();
    if (!Number.isInteger(item.id) || !name || !slug) return [];
    return [{ id: item.id!, name, slug, year: item.year ?? null }];
  });
  if (!options.fetchImpl) {
    searchCache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, value: anime });
  }
  return anime;
}

/** 作品名に完全一致する作品のOP/EDを取得する。APIのID絞り込みでは関連曲が空になるため名前を使う。 */
export async function getAnimeThemeSongs(
  animeName: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AnimeThemeSong[]> {
  const normalizedName = animeName.trim();
  if (!normalizedName) return [];
  const cacheKey = normalizedName.toLocaleLowerCase();
  if (!options.fetchImpl) {
    const hit = cached(themesCache, cacheKey);
    if (hit) return hit;
  }
  const params = new URLSearchParams({
    "filter[name]": normalizedName,
    include: "animethemes.song.artists",
  });
  const body = await fetchJson<AnimeResponse>(
    `${ANIME_THEMES_API_URL}/anime?${params}`,
    "anime.themes",
    options.fetchImpl ?? fetch,
  );
  const exactAnime = (body.anime ?? []).find((anime) => anime.name === normalizedName);
  const songs = (exactAnime?.animethemes ?? []).flatMap((theme) => {
    const type: AnimeThemeSong["type"] | null =
      theme.type === "OP" || theme.type === "ED" ? theme.type : null;
    const title = theme.song?.title?.trim();
    if (!type || !title) return [];
    return [{
      animeName: normalizedName,
      ...(exactAnime?.slug ? { animeSlug: exactAnime.slug } : {}),
      type,
      sequence: typeof theme.sequence === "number" ? theme.sequence : null,
      title,
      artists: (theme.song?.artists ?? []).flatMap((artist) =>
        artist.name?.trim() ? [artist.name.trim()] : []
      ),
    }];
  });
  if (!options.fetchImpl) {
    themesCache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, value: songs });
  }
  return songs;
}
