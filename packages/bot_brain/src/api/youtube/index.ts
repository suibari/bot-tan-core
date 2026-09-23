// youtube.ts
import axios from 'axios';
import { withMoodSongApiCall } from '../moodSongRequest.js';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

export async function searchYoutubeLink(query: string): Promise<string | null> {
  const res = await withMoodSongApiCall('youtube', 'search.link', (signal) =>
    axios.get(YOUTUBE_SEARCH_URL, {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'snippet',
        q: query,
        maxResults: 1,
        type: 'video'
      },
      signal,
    })
  );

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

// 曲名・歌手名をタグに入れたカバー動画も検索上位に来るため、先に除外する。
const COVER_MARKER = /歌ってみた|弾いてみた|ものまね|モノマネ|カラオケ|karaoke|\bcover\b|\bcovered by\b|\btribute\b|\bfan[ -]?made\b/i;
const OFFICIAL_MARKER = /official|公式|\bmv\b|music video/i;
const LABEL_CHANNEL = /sony music|universal music|warner music|avex|king records|vevo|aniplex/i;

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

  let best: YoutubeSongMatch | null = null;
  let bestScore = 0;
  for (const item of items) {
    const videoId = item.id?.videoId;
    const videoTitle = item.snippet?.title ?? '';
    const channelTitle = item.snippet?.channelTitle ?? '';
    const normalizedTitle = normalized(videoTitle);
    const normalizedEvidence = normalized(`${videoTitle} ${channelTitle}`);
    if (
      videoId &&
      !COVER_MARKER.test(videoTitle) &&
      (normalizedTitle.includes(expectedTitle) ||
        expectedTitleParts.some((part) => normalizedTitle.includes(part)) ||
        expectedContextTerms.some((term) => normalizedTitle.includes(term))) &&
      expectedArtists.some((value) => normalizedEvidence.includes(value))
    ) {
      const channel = normalized(channelTitle);
      const artistChannel = expectedArtists.some((value) => {
        if (channel === value) return true;
        if (!channel.startsWith(value)) return false;
        return /^(?:topic|vevo|official(?:youtube)?(?:channel)?)$/u.test(channel.slice(value.length));
      });
      const score = artistChannel ? 3 : OFFICIAL_MARKER.test(videoTitle) && LABEL_CHANNEL.test(channelTitle) ? 2 : 0;
      if (score <= bestScore) continue;
      bestScore = score;
      best = {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoTitle,
        channelTitle,
      };
    }
  }
  return best;
}

export async function searchYoutubeSong(
  title: string,
  artist: string,
  contextTerms: string[] = [],
): Promise<YoutubeSongMatch | null> {
  const res = await withMoodSongApiCall('youtube', 'search.song', (signal) =>
    axios.get(YOUTUBE_SEARCH_URL, {
      params: {
        key: YOUTUBE_API_KEY,
        part: 'snippet',
        q: `${artist} ${title}`,
        maxResults: 10,
        type: 'video',
      },
      signal,
    })
  );
  return selectYoutubeSongMatch(res.data.items ?? [], title, artist, contextTerms);
}
