import {
  db,
  nagiCommunityAffirmations,
  nagiCommunityAffirmationDismissals,
  nagiPosts,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import type {
  CommunityAffirmationPage,
  CommunityAffirmationView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getReactionViews } from "./reactions.js";
import { loadMutes, muteVisibility, type MuteSet } from "./mutes.js";
import { getBotActor } from "./timeline.js";

const ONE_HOUR_MS = 60 * 60 * 1_000;
export const COMMUNITY_AFFIRMATION_WINDOW_MS = 7 * 24 * ONE_HOUR_MS;

/**
 * カーソルの基準は「要約を生成した時刻」（community_affirmations.updated_at）。
 * 投稿日時ではなく生成時刻の降順に並べることで、新しく積まれた要約が必ず先頭に来る。
 */
export const encodeCommunityAffirmationCursor = (date: Date, uri: string) =>
  Buffer.from(JSON.stringify([date.toISOString(), uri])).toString("base64url");

export const decodeCommunityAffirmationCursor = (
  cursor?: string,
): [Date, string] | undefined => {
  if (!cursor) return undefined;
  try {
    const [date, uri] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) || typeof uri !== "string"
      ? undefined
      : [parsed, uri];
  } catch {
    return undefined;
  }
};

export function communityAffirmationVisibility(opts: {
  viewerDid: string;
  now: Date;
  lang: "ja" | "en";
  mutes: MuteSet;
}) {
  const dismissal = alias(
    nagiCommunityAffirmationDismissals,
    "community_affirmation_dismissal",
  );
  const viewerReaction = alias(nagiReactions, "viewer_reaction");
  return [
    eq(nagiCommunityAffirmations.state, "posted"),
    opts.lang === "ja"
      ? isNotNull(nagiCommunityAffirmations.summaryJa)
      : isNotNull(nagiCommunityAffirmations.summaryEn),
    eq(nagiPosts.uri, nagiCommunityAffirmations.sourceUri),
    eq(nagiPosts.cid, nagiCommunityAffirmations.sourceCid),
    isNull(nagiPosts.deletedAt),
    isNull(nagiPosts.replyParentUri),
    ne(nagiPosts.did, opts.viewerDid),
    gt(
      nagiPosts.recordCreatedAt,
      new Date(opts.now.getTime() - COMMUNITY_AFFIRMATION_WINDOW_MS),
    ),
    sql`coalesce((${nagiPosts.recordJson} ->> 'cwRestricted')::boolean, false) = false`,
    sql`${nagiPosts.text} not like '%||%'`,
    notExists(
      db
        .select({ sourceUri: dismissal.sourceUri })
        .from(dismissal)
        .where(
          and(
            eq(dismissal.viewerDid, opts.viewerDid),
            eq(dismissal.sourceUri, nagiPosts.uri),
            gt(dismissal.expiresAt, opts.now),
          ),
        ),
    ),
    notExists(
      db
        .select({ subjectUri: viewerReaction.subjectUri })
        .from(viewerReaction)
        .where(
          and(
            eq(viewerReaction.did, opts.viewerDid),
            eq(viewerReaction.subjectUri, nagiPosts.uri),
          ),
        ),
    ),
    sql`not exists (
      select 1
      from jsonb_array_elements(coalesce(${nagiPosts.embedImages}, '[]'::jsonb)) as image
      where coalesce((image ->> 'contentWarning')::boolean, false) = true
    )`,
    // ここで「リアクション1件以下」を再判定してはいけない。誰かが2つ目の反応を
    // 付けた瞬間に全ユーザーの一覧から消えてしまい、一覧がほとんど育たなかった。
    // この条件は候補選定時（NagiCommunityAffirmationWorker）だけで効かせる。
    // 「投稿から1時間以上経っていること」も候補時点で担保済みなので、ここでは見ない。
    ...muteVisibility(opts.mutes, { actors: true, channels: true }),
  ];
}

export async function getCommunityAffirmations(opts: {
  viewerDid: string;
  lang: "ja" | "en";
  limit: number;
  cursor?: string;
}): Promise<CommunityAffirmationPage> {
  const now = new Date();
  const point = decodeCommunityAffirmationCursor(opts.cursor);
  const mutes = await loadMutes(opts.viewerDid);
  const filters = communityAffirmationVisibility({
    viewerDid: opts.viewerDid,
    now,
    lang: opts.lang,
    mutes,
  });
  if (point)
    filters.push(
      or(
        lt(nagiCommunityAffirmations.updatedAt, point[0]),
        and(
          eq(nagiCommunityAffirmations.updatedAt, point[0]),
          lt(nagiCommunityAffirmations.sourceUri, point[1]),
        ),
      )!,
    );

  const rows = await db
    .select({
      uri: nagiPosts.uri,
      cid: nagiPosts.cid,
      authorDid: nagiPosts.did,
      embedImages: nagiPosts.embedImages,
      recordJson: nagiPosts.recordJson,
      stockedAt: nagiCommunityAffirmations.updatedAt,
      summaryJa: nagiCommunityAffirmations.summaryJa,
      summaryEn: nagiCommunityAffirmations.summaryEn,
    })
    .from(nagiCommunityAffirmations)
    .innerJoin(
      nagiPosts,
      and(
        eq(nagiPosts.uri, nagiCommunityAffirmations.sourceUri),
        eq(nagiPosts.cid, nagiCommunityAffirmations.sourceCid),
      ),
    )
    .where(and(...filters))
    // 生成が新しい順。毎回いちばん新しい要約から見えるようにする。
    .orderBy(
      desc(nagiCommunityAffirmations.updatedAt),
      desc(nagiCommunityAffirmations.sourceUri),
    )
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const [reactions, botActor] = await Promise.all([
    getReactionViews(
      page.map((row) => row.uri),
      opts.viewerDid,
    ),
    getBotActor(),
  ]);
  const items: CommunityAffirmationView[] = page.map((row) => {
    // 「その要約に自分がどうするか」だけの機能なので、他人の反応は返さない。
    // 件数も反応した人も出さないよう、自分が押したものだけを 1 件として渡す。
    const visibleReactions = (reactions.get(row.uri) ?? []).flatMap(
      (reaction) =>
        reaction.reactedByMe
          ? [{ ...reaction, reactors: [], hasMoreReactors: false }]
          : [],
    );
    const images = Array.isArray(row.embedImages)
      ? (row.embedImages as any[]).flatMap((item: any) => {
          const cid = item?.image?.ref?.$link;
          if (typeof cid !== "string" || typeof item?.alt !== "string")
            return [];
          return [
            {
              url: `/api/blob/${encodeURIComponent(row.authorDid)}/${encodeURIComponent(cid)}`,
              alt: item.alt,
              ...(item.contentWarning === true ? { contentWarning: true } : {}),
              ...(item.aspectRatio ? { aspectRatio: item.aspectRatio } : {}),
            },
          ];
        })
      : undefined;
    const linkCards = Array.isArray((row.recordJson as any)?.linkCards)
      ? ((row.recordJson as any).linkCards as any[]).flatMap((card: any) => {
          if (typeof card?.uri !== "string" || typeof card?.title !== "string")
            return [];
          const cid = card.thumb?.ref?.$link;
          return [
            {
              uri: card.uri,
              title: card.title,
              ...(typeof card.description === "string"
                ? { description: card.description }
                : {}),
              ...(typeof cid === "string"
                ? {
                    thumb: `/api/blob/${encodeURIComponent(row.authorDid)}/${encodeURIComponent(cid)}`,
                  }
                : {}),
            },
          ];
        })
      : undefined;
    return {
      uri: row.uri,
      cid: row.cid,
      summary:
        (opts.lang === "ja" ? row.summaryJa : row.summaryEn) ??
        row.summaryJa ??
        row.summaryEn ??
        "",
      createdAt: row.stockedAt.toISOString(),
      reactions: visibleReactions,
      images: images?.length ? images : undefined,
      linkCards: linkCards?.length ? linkCards : undefined,
    };
  });
  const last = page.at(-1);
  return {
    items,
    botActor,
    hasMore: rows.length > opts.limit,
    cursor:
      rows.length > opts.limit && last
        ? encodeCommunityAffirmationCursor(last.stockedAt, last.uri)
        : undefined,
  };
}
