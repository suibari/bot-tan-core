/**
 * video.bsky.app が変換した動画の配信先。
 * Bluesky の投稿から参照されていない blob も uploadVideo の直後は返るが、数日で 404 になる
 * （2026-10-16 実測）。Nagi の投稿の再生は AppView の /api/video を通すこと。
 */
const VIDEO_ORIGIN = "https://video.bsky.app";

export function blueskyVideoUrls(did: string, cid: string) {
  const base = `${VIDEO_ORIGIN}/watch/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
  return {
    playlist: `${base}/playlist.m3u8`,
    thumbnail: `${base}/thumbnail.jpg`,
  };
}
