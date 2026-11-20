import { db, nagiActors, nagiPostScores, nagiPosts, nagiProfiles } from "@bsky-affirmative-bot/database";
import { NAGI, type FeedItem } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { config } from "../config.js";
import { viewerIsAdult } from "../services/ageAssurance.js";
import { loadMutes } from "./mutes.js";
import {
  buildFeedItems,
  decodeCursor,
  encodeCursor,
  getBotActor,
  postSelection,
  timelineVisibilityFilters,
} from "./timeline.js";

/** ニュースを引用した botたんの投稿（定期ポスト）。quote_uri のインデックスで引ける。 */
export async function botPostsQuotingNews(newsUri: string): Promise<string[]> {
  const rows = await db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(
      and(
        eq(nagiPosts.quoteUri, newsUri),
        eq(nagiPosts.did, config.botDid),
        isNull(nagiPosts.deletedAt),
      ),
    );
  return rows.map((row) => row.uri);
}

/**
 * 「このニュースへのコメント」とみなす投稿の条件。
 *
 * - 利用者がニュースを引用した投稿。
 * - botたんの定期ポスト（ニュースを引用し、読者への問いかけで締めている）への返信。
 *   返信はレコード上ニュースを引用していないが、問いかけへの答えなので中身はニュースへの
 *   コメントになる。スレッドのどの深さの返信でも、ルートがその定期ポストなら含める。
 *
 * botたん自身の投稿は含めない。定期ポストの問いかけはニュースページの botたんコメントと
 * 重なり、スレッド内の返信は会話のやり取りで、ニュースへの感想ではない。
 *
 * 定期ポストの URI は先に引いて値で渡す。OR の中に相関サブクエリを置くとプランナーが
 * quote_uri / reply_root_uri のインデックスを使えず、posts を全件スキャンした
 * （2026-11-20 本番で EXPLAIN）。値の一覧なら両インデックスの BitmapOr になる。
 */
export function newsCommentCondition(newsUri: string, botPostUris: string[]) {
  return and(
    ne(nagiPosts.did, config.botDid),
    botPostUris.length
      ? or(eq(nagiPosts.quoteUri, newsUri), inArray(nagiPosts.replyRootUri, botPostUris))
      : eq(nagiPosts.quoteUri, newsUri),
  )!;
}

/**
 * ニュースのパーマリンクに出す「みんなのコメント」。newsCommentCondition の投稿を新しい順に返す。
 *
 * 外からニュースページへ来た人に、Nagi の中でその話題がどう受け止められたかを見せるための読み口。
 * 可視性は共有TLと同じ条件（timelineVisibilityFilters）に乗せる。こっそり・ミュート・
 * 成人向け・bot返信の除外を別に書くと、隠れているべき投稿がここから漏れる。
 */
export async function getNewsQuotes(opts: {
  uri: string;
  limit: number;
  cursor?: string;
  viewerDid?: string;
}): Promise<{
  items: FeedItem[];
  botActor?: FeedItem["author"];
  cursor?: string;
  hasMore: boolean;
}> {
  if (opts.uri.split("/")[3] !== NAGI.news) return { items: [], hasMore: false };
  const [mutes, isAdult, botPostUris] = await Promise.all([
    loadMutes(opts.viewerDid),
    viewerIsAdult(opts.viewerDid),
    botPostsQuotingNews(opts.uri),
  ]);
  const filters = timelineVisibilityFilters(
    { viewerDid: opts.viewerDid },
    {
      mutes,
      muteActors: mutes.actors.length > 0,
      muteTags: mutes.tags.length > 0,
      isAdult,
    },
  );
  filters.push(newsCommentCondition(opts.uri, botPostUris));
  const point = decodeCursor(opts.cursor);
  if (point)
    filters.push(
      or(
        lt(nagiPosts.indexedAt, point[0]),
        and(eq(nagiPosts.indexedAt, point[0]), lt(nagiPosts.uri, point[1])),
      ),
    );
  const rows = await db
    .select(postSelection)
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(and(...filters))
    .orderBy(desc(nagiPosts.indexedAt), desc(nagiPosts.uri))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const [items, botActor] = await Promise.all([
    buildFeedItems(page, opts.viewerDid, true, false, mutes),
    getBotActor(),
  ]);
  const last = page.at(-1)?.post;
  return {
    items,
    botActor,
    hasMore: rows.length > opts.limit,
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(last.indexedAt, last.uri)
        : undefined,
  };
}
