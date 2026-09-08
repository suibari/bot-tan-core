import { db, nagiPosts } from "@bsky-affirmative-bot/database";
import type { ThreadView } from "@bsky-affirmative-bot/nagi-lexicon";
import { eq, or } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { buildFeedItems, fetchPostRows, getBotActor } from "./timeline.js";
export async function getThread(
  uri: string,
  viewerDid?: string,
): Promise<{ thread: ThreadView }> {
  const [requested] = await db
    .select({ uri: nagiPosts.uri, replyRootUri: nagiPosts.replyRootUri })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, uri))
    .limit(1);
  if (!requested) throw new ApiError(404, "not_found", "Thread not found");

  // 返信のURLから開いた場合も、StrongRef が指す真のルートを起点にスレッド全体を返す。
  // ルートを解決できない状態で返信だけを見せると、ルート所有の可視性を誤るため fail closed にする。
  const rootUri = requested.replyRootUri ?? requested.uri;

  // こっそりスレッドは著者本人と botたんだけのもの。共有TLや検索と違い、ここは URI を
  // 直接指定して来る経路なので、フィルタではなく 404 で存在ごと伏せる（「あるが読めない」と
  // 分かるだけで、誰がいつ書いたかの手がかりになるため）。
  const [root] = await db
    .select({ did: nagiPosts.did, kossori: nagiPosts.kossori })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, rootUri))
    .limit(1);
  if (!root) throw new ApiError(404, "not_found", "Thread not found");
  if (root.kossori && root.did !== viewerDid)
    throw new ApiError(404, "not_found", "Thread not found");

  const rows = await db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(or(eq(nagiPosts.uri, rootUri), eq(nagiPosts.replyRootUri, rootUri)));
  // 詳細画面でもタイムラインと同じ bot 返信ジョブ状態を返す。indexed 済みの bot 返信は
  // replies に実体があるため、クライアントは botReplyState の待機系だけを状態表示に使う。
  const [views, botActor] = await Promise.all([
    buildFeedItems(await fetchPostRows(rows.map((r) => r.uri)), viewerDid),
    getBotActor(),
  ]);
  const post = views.find((v) => v.uri === rootUri);
  if (!post) throw new ApiError(404, "not_found", "Thread not found");
  const replies = views
    // URL で直接開かれた保存拒否済みの返信は、理由付きの墓標を見せる。
    // 通常のスレッド閲覧では、他の削除済み返信は従来どおり出さない。
    .filter((v) => v.uri !== rootUri && (!v.deleted || v.uri === uri))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { thread: { post, replies, botActor } };
}

