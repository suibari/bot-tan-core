// youtube.ts
import axios from 'axios';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

export async function searchYoutubeLink(query: string): Promise<string | null> {
  const res = await axios.get(YOUTUBE_SEARCH_URL, {
    params: {
      key: YOUTUBE_API_KEY,
      part: 'snippet',
      q: query,
      maxResults: 1,
      type: 'video'
    }
  });

  const videoId = res.data.items?.[0]?.id?.videoId;
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

export interface YoutubeSongMatch {
  videoId: string;
  url: string;
  videoTitle: string;
  channelTitle: string;
}

interface YoutubeSearchItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string };
}

const normalized = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/&(?:amp|quot|#39);/g, '')
  .replace(/[^\p{Letter}\p{Number}]+/gu, '');

const distinctiveTitleParts = (value: string) => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .split(/[^\p{Letter}\p{Number}]+/gu)
  .map(normalized)
  .filter((part) => part.length >= 4 && !/^(?:official|music|video|theme|opening|ending)$/u.test(part));

function artistAliases(artist: string) {
  const values = [artist];
  for (const match of artist.matchAll(/[（(]([^）)]+)[）)]/g)) values.push(match[1]);
  values.push(...artist.split(/[／/&、,]/));
  return [...new Set(values.map(normalized).filter((value) => value.length >= 2))];
}

/** YouTube の検索上位から、曲名と作者の両方を確認できる動画だけを採用する。 */
export function selectYoutubeSongMatch(
  items: YoutubeSearchItem[],
  title: string,
  artist: string,
  contextTerms: string[] = [],
): YoutubeSongMatch | null {
  const expectedTitle = normalized(title);
  const expectedTitleParts = distinctiveTitleParts(title);
  const expectedContextTerms = contextTerms.map(normalized).filter((value) => value.length >= 3);
  const expectedArtists = artistAliases(artist);
  if (!expectedTitle || expectedArtists.length === 0) return null;

  for (const item of items) {
    const videoId = item.id?.videoId;
    const videoTitle = item.snippet?.title ?? '';
    const channelTitle = item.snippet?.channelTitle ?? '';
    const normalizedTitle = normalized(videoTitle);
    const normalizedEvidence = normalized(`${videoTitle} ${channelTitle}`);
    if (
      videoId &&
      (normalizedTitle.includes(expectedTitle) ||
        expectedTitleParts.some((part) => normalizedTitle.includes(part)) ||
        expectedContextTerms.some((term) => normalizedTitle.includes(term))) &&
      expectedArtists.some((value) => normalizedEvidence.includes(value))
    ) {
      return {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoTitle,
        channelTitle,
      };
    }
  }
  return null;
}

export async function searchYoutubeSong(
  title: string,
  artist: string,
  contextTerms: string[] = [],
): Promise<YoutubeSongMatch | null> {
  const res = await axios.get(YOUTUBE_SEARCH_URL, {
    params: {
      key: YOUTUBE_API_KEY,
      part: 'snippet',
      q: `${artist} ${title}`,
      maxResults: 5,
      type: 'video',
    },
    timeout: 15_000,
  });
  return selectYoutubeSongMatch(res.data.items ?? [], title, artist, contextTerms);
}
