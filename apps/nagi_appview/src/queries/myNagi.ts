import { db, nagiPosts } from "@bsky-affirmative-bot/database";
import type { MyNagiView } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, isNull, sql } from "drizzle-orm";
import {
  buildConversationItems,
  fetchPostRows,
  homeRootVisibility,
} from "./timeline.js";
import { loadPrivateListMemberDids } from "./privateList.js";
import { loadMutes, muteVisibility } from "./mutes.js";

/**
 * my Nagi の「リスト動向」セクション。
 *
 * 既存の getHomeTimeline を limit=N で叩くだけだと活発な1人が枠を埋めてしまうので、
 * ここは 1人につき最新1件だけを拾う（distinct on）。ページングはしない
 * ——「もっと見る」で既存のタイムラインへ送る前提の、顔ぶれを見せるための枠。
 */
const DEFAULT_LIMIT = 6;

export async function getMyNagi(opts: {
  viewerDid: string;
  limit?: number;
}): Promise<MyNagiView> {
  const limit = Math.min(20, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const [memberDids, mutes] = await Promise.all([
    loadPrivateListMemberDids(opts.viewerDid),
    loadMutes(opts.viewerDid),
  ]);
  return {
    listUsers: await latestPerListUser(opts.viewerDid, memberDids, limit, mutes),
  };
}

async function latestPerListUser(
  viewerDid: string,
  memberDids: string[],
  limit: number,
  mutes: Awaited<ReturnType<typeof loadMutes>>,
): Promise<MyNagiView["listUsers"]> {
  if (!memberDids.length) return [];
  // 可視条件はルート投稿だけを見る版（返信除外 / CH 限定除外 / 他人の kossori 除外）。
  // ホームTLは返信も候補に入れてスレッドの最新活動順に並べるが、ここは「1人の最新の一言」を
  // 見せる枠なので、返信で顔ぶれが入れ替わらないようルート投稿に限る。
  // 自分自身と botたん は別セクションで出すので、ここでは非公開リストの人だけを見る。
  const rows = await db
    .selectDistinctOn([nagiPosts.did], {
      uri: nagiPosts.uri,
      did: nagiPosts.did,
    })
    .from(nagiPosts)
    .where(
      and(
        isNull(nagiPosts.deletedAt),
        ...homeRootVisibility(viewerDid, memberDids),
        ...muteVisibility(mutes, { actors: true, tags: true }),
      ),
    )
    .orderBy(nagiPosts.did, sql`${nagiPosts.recordCreatedAt} desc`);
  if (!rows.length) return [];

  const items = await buildConversationItems(
    await fetchPostRows(rows.map((row) => row.uri)),
    viewerDid,
    mutes,
  );
  // 1人1件になったところで、全体としては新着順に並べ替えてから上位を返す。
  return items
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit)
    .map((post) => ({ actor: post.author, post }));
}
