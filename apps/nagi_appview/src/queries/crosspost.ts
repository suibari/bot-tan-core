import type { PostView, StrongRef } from "@bsky-affirmative-bot/nagi-lexicon";

const BSKY_POST = "app.bsky.feed.post";

function blueskyPostRef(value: unknown, did: string): StrongRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { uri, cid } = value as { uri?: unknown; cid?: unknown };
  if (typeof uri !== "string" || typeof cid !== "string" || !cid) return undefined;
  // 自分の repo の Bluesky 投稿だけを認める。他人の投稿を「自分のクロスポスト」とは名乗らせない。
  return uri.startsWith(`at://${did}/${BSKY_POST}/`) ? { uri, cid } : undefined;
}

/**
 * 投稿レコードの crosspost（Bluesky に同時投稿したコピーへの参照）を、作者本人にだけ返す。
 * 本人が「Bluesky にも続けられる」と分かるためのもので、他人には目印を出さない。
 * root はコピーの先頭、tail は分割したときの末尾、threadRoot は Bluesky 上のスレッドの先頭。
 */
export function crosspostView(
  did: string,
  record: any,
  viewerDid: string | undefined,
): Pick<PostView, "crosspost"> {
  if (!viewerDid || viewerDid !== did) return {};
  const value = record?.crosspost;
  const root = blueskyPostRef(value?.root, did);
  const tail = blueskyPostRef(value?.tail, did);
  if (!root || !tail) return {};
  const threadRoot = blueskyPostRef(value?.threadRoot, did) ?? root;
  return { crosspost: { root, tail, threadRoot } };
}
