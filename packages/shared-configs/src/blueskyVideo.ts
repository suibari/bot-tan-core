/**
 * video.bsky.app が変換した動画の配信先。
 * Bluesky の投稿から参照されていない blob でも、uploadVideo を通っていれば返る（2026-10-09 実測）。
 */
const VIDEO_ORIGIN = "https://video.bsky.app";

export function blueskyVideoUrls(did: string, cid: string) {
  const base = `${VIDEO_ORIGIN}/watch/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
  return {
    playlist: `${base}/playlist.m3u8`,
    thumbnail: `${base}/thumbnail.jpg`,
  };
}
