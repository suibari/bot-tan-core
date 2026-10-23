import { db, nagiActors, nagiPostScores, nagiPosts, nagiProfiles } from "@bsky-affirmative-bot/database";
import { NAGI, type FeedItem } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, lt, or } from "drizzle-orm";
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

/**
 * ニュースのパーマリンクに出す「みんなのコメント」。そのニュースを引用した投稿を新しい順に返す。
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
  const [mutes, isAdult] = await Promise.all([
    loadMutes(opts.viewerDid),
    viewerIsAdult(opts.viewerDid),
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
  filters.push(eq(nagiPosts.quoteUri, opts.uri));
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
