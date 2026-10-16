import type { PostView } from "@bsky-affirmative-bot/nagi-lexicon";
import { appviewPublicUrl } from "../util/publicUrl.js";

/**
 * 動画の配信先は AppView の /api/video。video.bsky.app に変換結果があればそちらへ
 * リダイレクトし、消えていれば PDS の mp4 から作った HLS を返す（routes/video.ts）。
 * クライアントは他の添付と違い相対パスを前置しないので、絶対 URL で渡す。
 */
export function nagiVideoUrls(did: string, cid: string) {
  const base = `${appviewPublicUrl()}/api/video/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
  return {
    playlist: `${base}/playlist.m3u8`,
    thumbnail: `${base}/thumbnail.jpg`,
  };
}

/** embed_video の値から、再生用の HLS とサムネイルを指すビューを作る。 */
export function postVideoView(
  did: string,
  value: unknown,
): PostView["video"] | undefined {
  const item = value as any;
  const cid = item?.video?.ref?.$link;
  if (typeof cid !== "string" || !cid) return undefined;
  return {
    ...nagiVideoUrls(did, cid),
    ...(typeof item.alt === "string" && item.alt ? { alt: item.alt } : {}),
    ...(item.contentWarning === true ? { contentWarning: true } : {}),
    ...(item.aspectRatio ? { aspectRatio: item.aspectRatio } : {}),
  };
}
