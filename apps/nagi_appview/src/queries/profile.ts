import {
  db,
  nagiActorAnalyses,
  nagiActors,
  nagiEmojis,
  nagiNews,
  nagiNewsApprovals,
  nagiPostScores,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import type {
  ProfileDetail,
  ProfileFeedItem,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import { getCurrentTitle, getSuperPositiveLevel } from "./badges.js";
import {
  buildFeedItems,
  decodeCursor,
  encodeCursor,
  getBotActor,
  postSelection,
  type PostRow,
} from "./timeline.js";
import { getApprovedNewsViews, type NewsLang } from "./positiveNews.js";
import { emojiView } from "../services/emoji.js";
export async function getActorProfile(
  did: string,
  lang: "ja" | "en" = "ja",
): Promise<ProfileDetail> {
  const [[actor], [profile], [stats], superPositiveLevel, currentTitle, [analysis]] =
    await Promise.all([
      db.select().from(nagiActors).where(eq(nagiActors.did, did)),
      db.select().from(nagiProfiles).where(eq(nagiProfiles.did, did)),
      db
        .select({
          postCount: sql<number>`count(*)::int`,
          firstPostAt: sql<string | null>`min(${nagiPosts.recordCreatedAt})`,
        })
        .from(nagiPosts)
        .where(and(eq(nagiPosts.did, did), isNull(nagiPosts.deletedAt))),
      getSuperPositiveLevel(did),
      getCurrentTitle(did),
      db
        .select({
          analysisJa: nagiActorAnalyses.analysisJa,
          analysisEn: nagiActorAnalyses.analysisEn,
          taglineJa: nagiActorAnalyses.taglineJa,
          taglineEn: nagiActorAnalyses.taglineEn,
          tagsJa: nagiActorAnalyses.tagsJa,
          tagsEn: nagiActorAnalyses.tagsEn,
          updatedAt: nagiActorAnalyses.updatedAt,
        })
        .from(nagiActorAnalyses)
        .where(eq(nagiActorAnalyses.did, did)),
    ]);
  if (!actor && !profile && !stats?.postCount)
    throw new ApiError(404, "not_found", "Actor not found");
  const firstPostAt = stats?.firstPostAt
    ? new Date(stats.firstPostAt).toISOString()
    : undefined;
  const comment = analysis
    ? (lang === "en" ? analysis.analysisEn : analysis.analysisJa) || undefined
    : undefined;
  // 名刺用の3項目。prompt_version が v1 のままの行では NULL なので undefined を返し、
  // クライアント側で comment からのフォールバックに落とす。
  const tagline = analysis
    ? (lang === "en" ? analysis.taglineEn : analysis.taglineJa) || undefined
    : undefined;
  const tags = analysis
    ? (lang === "en" ? analysis.tagsEn : analysis.tagsJa) || undefined
    : undefined;
  return {
    did,
    handle: actor?.handle ?? did,
    displayName: profile?.displayName ?? undefined,
    description: profile?.description ?? undefined,
    avatar: profile?.avatarCid
      ? `/api/blob/${encodeURIComponent(did)}/${profile.avatarCid}`
      : undefined,
    isBot: did === config.botDid,
    superPositiveLevel,
    currentTitle,
    postCount: stats?.postCount ?? 0,
    firstPostAt,
    joinedAt: profile?.createdAt?.toISOString() ?? firstPostAt,
    comment,
    tagline,
    tags,
    cardUpdatedAt: analysis?.updatedAt?.toISOString(),
  };
}
export async function getReactedFeed(opts: {
  actorDid: string;
  limit: number;
  cursor?: string;
  viewerDid?: string;
  lang: NewsLang;
}) {
  // 他人のプロフィールから「誰が誰へ反応したか」を時系列で追えないよう、
  // リアクション履歴は本人にだけ返す。古いクライアントにも安全な空ページで応答する。
  if (!canReadReactionHistory(opts.actorDid, opts.viewerDid))
    return { items: [], hasMore: false };
  const point = decodeCursor(opts.cursor);
  const eligiblePost = exists(
    db
      .select({ value: sql`1` })
      .from(nagiPosts)
      .where(
        and(
          eq(nagiPosts.uri, nagiReactions.subjectUri),
          isNull(nagiPosts.deletedAt),
        ),
      ),
  );
  const eligibleNews = exists(
    db
      .select({ value: sql`1` })
      .from(nagiNews)
      .innerJoin(
        nagiNewsApprovals,
        and(
          eq(nagiNewsApprovals.newsUri, nagiNews.uri),
          eq(nagiNewsApprovals.newsCid, nagiNews.cid),
        ),
      )
      .where(
        and(
          eq(nagiNews.uri, nagiReactions.subjectUri),
          isNull(nagiNews.deletedAt),
          eq(nagiNewsApprovals.status, "approved"),
        ),
      ),
  );
  const ranked = db.$with("ranked_reactions").as(
    db
      .select({
        subjectUri: nagiReactions.subjectUri,
        reactionUri: nagiReactions.uri,
        reactionIndexedAt: nagiReactions.indexedAt,
        emoji: nagiReactions.emoji,
        emojiUri: nagiReactions.emojiUri,
        rank: sql<number>`row_number() over (
          partition by ${nagiReactions.subjectUri}
          order by ${nagiReactions.indexedAt} desc, ${nagiReactions.uri} desc
        )`.as("reaction_rank"),
      })
      .from(nagiReactions)
      .where(
        and(
          eq(nagiReactions.did, opts.actorDid),
          or(eligiblePost, eligibleNews),
        ),
      ),
  );
  const filters: any[] = [eq(ranked.rank, 1)];
  if (point)
    filters.push(
      or(
        lt(ranked.reactionIndexedAt, point[0]),
        and(
          eq(ranked.reactionIndexedAt, point[0]),
          lt(ranked.reactionUri, point[1]),
        ),
      ),
    );
  const rows = await db
    .with(ranked)
    .select({
      subjectUri: ranked.subjectUri,
      reactionUri: ranked.reactionUri,
      reactionIndexedAt: ranked.reactionIndexedAt,
      emoji: ranked.emoji,
      emojiUri: ranked.emojiUri,
    })
    .from(ranked)
    .where(and(...filters))
    .orderBy(desc(ranked.reactionIndexedAt), desc(ranked.reactionUri))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const subjectUris = page.map((row) => row.subjectUri);
  const postRows: PostRow[] = subjectUris.length
    ? await db
        .select(postSelection)
        .from(nagiPosts)
        .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
        .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
        .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
        .where(
          and(inArray(nagiPosts.uri, subjectUris), isNull(nagiPosts.deletedAt)),
        )
    : [];
  // こっそり投稿へのリアクション。「みんなで全肯定」の匿名要約から押せるので、他人の
  // こっそり投稿がここに並ぶことがある。本文も作者も辿らせないが、黙って落とすと
  // 「押したはずのものが無い」になるため、時系列の位置は保ったままプレースホルダにする。
  // 判定を kossori 列で行うので、URI が不透明化される前に押された既存のリアクションも
  // まとめて伏せられる（バックフィル不要）。
  const hiddenKossoriUris = new Set(
    postRows
      .filter(({ post }) => post.kossori && post.did !== opts.viewerDid)
      .map(({ post }) => post.uri),
  );
  // 元投稿の情報は返さず、履歴カードに必要な「本人が押した絵文字」だけを解決する。
  // 通常投稿・ニュースの絵文字は既存の各 View が解決するので、ここでは重複取得しない。
  const hiddenEmojiUris = [
    ...new Set(
      page.flatMap((row) =>
        hiddenKossoriUris.has(row.subjectUri) && row.emojiUri ? [row.emojiUri] : [],
      ),
    ),
  ];
  const hiddenEmojiRows = hiddenEmojiUris.length
    ? await db
        .select()
        .from(nagiEmojis)
        .where(inArray(nagiEmojis.uri, hiddenEmojiUris))
    : [];
  const emojiByUri = new Map(
    hiddenEmojiRows.flatMap((row) => {
      const view = emojiView(row);
      return view ? [[row.uri, view] as const] : [];
    }),
  );
  const [postItems, newsByUri, botActor] = await Promise.all([
    buildFeedItems(
      postRows.filter(({ post }) => !hiddenKossoriUris.has(post.uri)),
      opts.viewerDid,
    ),
    getApprovedNewsViews(subjectUris, opts.lang, opts.viewerDid),
    getBotActor(),
  ]);
  const postByUri = new Map(postItems.map((item) => [item.uri, item]));
  const items = page.flatMap<ProfileFeedItem>((row) => {
    if (hiddenKossoriUris.has(row.subjectUri))
      return [
        {
          kind: "kossori" as const,
          reactionUri: row.reactionUri,
          reactedAt: row.reactionIndexedAt.toISOString(),
          emoji: row.emoji,
          ...(row.emojiUri && emojiByUri.has(row.emojiUri)
            ? { bluemoji: emojiByUri.get(row.emojiUri) }
            : {}),
        },
      ];
    const post = postByUri.get(row.subjectUri);
    if (post) return [post];
    const news = newsByUri.get(row.subjectUri);
    return news ? [{ kind: "news" as const, news }] : [];
  });
  const last = page.at(-1);
  return {
    items,
    botActor,
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(last.reactionIndexedAt, last.reactionUri)
        : undefined,
    hasMore: rows.length > opts.limit,
  };
}

export const canReadReactionHistory = (
  actorDid: string,
  viewerDid?: string,
): boolean => actorDid === viewerDid;
