import type { PostView } from "@bsky-affirmative-bot/nagi-lexicon";
import { blueskyVideoUrls } from "@bsky-affirmative-bot/shared-configs/blueskyVideo";

/** embed_video の値から、video.bsky.app の HLS とサムネイルを指すビューを作る。 */
export function postVideoView(
  did: string,
  value: unknown,
): PostView["video"] | undefined {
  const item = value as any;
  const cid = item?.video?.ref?.$link;
  if (typeof cid !== "string" || !cid) return undefined;
  return {
    ...blueskyVideoUrls(did, cid),
    ...(typeof item.alt === "string" && item.alt ? { alt: item.alt } : {}),
    ...(item.contentWarning === true ? { contentWarning: true } : {}),
    ...(item.aspectRatio ? { aspectRatio: item.aspectRatio } : {}),
  };
}
