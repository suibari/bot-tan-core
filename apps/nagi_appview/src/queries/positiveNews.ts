import {
  db,
  nagiActors,
  nagiNews,
  nagiNewsApprovals,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import type {
  NewsView,
  Page,
  RecommendedNewsView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { decodeCursor, encodeCursor, getBotActor } from "./timeline.js";
import { getReactionViews } from "./reactions.js";
import {
  embedQuery,
  hybridConditions,
  lexicalMatch,
  relativeCut,
  SEMANTIC_LIMIT,
  semanticConditions,
  type SearchMode,
} from "./hybridSearch.js";
import { loadMutes, type MuteSet } from "./mutes.js";
import { loadNewsReasons, nearestOwnPost } from "./personalizedFeed.js";
import { embeddingProfile } from "@bsky-affirmative-bot/database";

export type NewsLang = "ja" | "en";

const hasTrustedSnapshot = or(
  eq(nagiNews.did, config.botDid),
  and(
    isNotNull(nagiNewsApprovals.snapshotUrl),
    isNotNull(nagiNewsApprovals.snapshotTitleJa),
    isNotNull(nagiNewsApprovals.snapshotCreatedAt),
  ),
)!;

// 検索は関連順のため offset ベースのページング（一覧の keyset とは別系統）。
const encodeOffset = (offset: number) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeOffset = (cursor?: string): number => {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

function view(
  row: {
    news: typeof nagiNews.$inferSelect;
    approval: typeof nagiNewsApprovals.$inferSelect;
    actor?: typeof nagiActors.$inferSelect | null;
    profile?: typeof nagiProfiles.$inferSelect | null;
  },
  lang: NewsLang,
  reactions: NewsView["reactions"] = [],
): NewsView {
  const useEn =
    lang === "en" && Boolean(row.approval.titleEn && row.approval.botCommentEn);
  const userSubmitted = row.news.did !== config.botDid;
  // ユーザー所有レコードは承認後も編集できるため、公開値をPDSへフォールバックしない。
  // bot所有の既存承認だけは、スナップショット導入前の行との互換性を保つ。
  const snapshotUrl = userSubmitted
    ? row.approval.snapshotUrl!
    : row.approval.snapshotUrl ?? row.news.url;
  const snapshotTitle = userSubmitted
    ? row.approval.snapshotTitleJa!
    : row.approval.snapshotTitleJa ?? row.news.titleJa;
  const sourceName = userSubmitted
    ? row.approval.snapshotSourceName
    : row.approval.snapshotSourceName ?? row.news.sourceName;
  const sourceUrl = userSubmitted
    ? row.approval.snapshotSourceUrl
    : row.approval.snapshotSourceUrl ?? row.news.sourceUrl;
  const publishedAt = userSubmitted
    ? row.approval.snapshotPublishedAt
    : row.approval.snapshotPublishedAt ?? row.news.publishedAt;
  const createdAt = userSubmitted
    ? row.approval.snapshotCreatedAt!
    : row.approval.snapshotCreatedAt ?? row.news.recordCreatedAt;
  return {
    uri: row.news.uri,
    cid: row.news.cid,
    articleId: row.approval.snapshotArticleId ?? row.news.articleId,
    url: snapshotUrl,
    title: useEn ? row.approval.titleEn! : snapshotTitle,
    sourceName: sourceName ?? undefined,
    sourceUrl: sourceUrl ?? undefined,
    publishedAt: publishedAt?.toISOString(),
    botComment: useEn ? row.approval.botCommentEn! : row.approval.botCommentJa!,
    lang: useEn ? "en" : "ja",
    createdAt: createdAt.toISOString(),
    indexedAt: row.news.indexedAt.toISOString(),
    reactions,
    ...(row.news.did !== config.botDid
      ? {
          submittedBy: {
            did: row.news.did,
            handle: row.actor?.handle ?? row.news.did,
            ...(row.profile?.displayName ? { displayName: row.profile.displayName } : {}),
            ...(row.profile?.avatarCid
              ? {
                  avatar: `/api/blob/${encodeURIComponent(row.news.did)}/${row.profile.avatarCid}`,
                }
              : {}),
          },
        }
      : {}),
  };
}

export async function getPositiveNews(opts: {
  limit: number;
  cursor?: string;
  lang: NewsLang;
  viewerDid?: string;
}): Promise<Page<NewsView>> {
  const point = decodeCursor(opts.cursor);
  const mutes = await loadMutes(opts.viewerDid);
  const filters: any[] = [
    isNull(nagiNews.deletedAt),
    eq(nagiNewsApprovals.status, "approved"),
    eq(nagiNewsApprovals.newsCid, nagiNews.cid),
    hasTrustedSnapshot,
    sql`${nagiNews.indexedAt} >= now() - interval '14 days'`,
    or(eq(nagiNews.did, config.botDid), isNull(nagiActors.did), eq(nagiActors.status, "active")),
  ];
  if (mutes.actors.length) filters.push(notInArray(nagiNews.did, mutes.actors));
  if (point)
    filters.push(
      or(
        lt(nagiNews.indexedAt, point[0]),
        and(eq(nagiNews.indexedAt, point[0]), lt(nagiNews.uri, point[1])),
      ),
    );
  const rows = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals, actor: nagiActors, profile: nagiProfiles })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(and(...filters))
    .orderBy(desc(nagiNews.indexedAt), desc(nagiNews.uri))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1)?.news;
  const [reactions, botActor] = await Promise.all([
    getReactionViews(
      page.map((row) => row.news.uri),
      opts.viewerDid,
    ),
    getBotActor(),
  ]);
  return {
    items: page.map((row) =>
      view(row, opts.lang, reactions.get(row.news.uri) ?? []),
    ),
    botActor,
    hasMore: rows.length > opts.limit,
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(last.indexedAt, last.uri)
        : undefined,
  };
}

/**
 * ニュースの自然文検索。承認済みニュースの titleJa を対象に意味検索(pgvector)+trgm 語彙一致の
 * ハイブリッド。出力形状は getPositiveNews と同じ（14日制限は設けず、承認済みなら全期間対象）。
 */
export async function searchNews(opts: {
  q: string;
  limit: number;
  cursor?: string;
  lang: NewsLang;
  viewerDid?: string;
  mode?: SearchMode;
}): Promise<Page<NewsView>> {
  const q = opts.q.trim();
  const mode: SearchMode = opts.mode ?? "hybrid";
  const offset = decodeOffset(opts.cursor);
  const mutes = await loadMutes(opts.viewerDid);
  // exact は埋め込みを使わないので Ollama 往復ごと省く。
  const embedding =
    mode === "exact" ? null : await embedQuery(q, { expand: mode === "semantic" });
  const textExpr = sql`coalesce(${nagiNewsApprovals.snapshotTitleJa}, ${nagiNews.titleJa})`;
  const noDistance = sql<number>`0`;
  const conditions =
    mode === "exact"
      ? {
          match: lexicalMatch({ q, textExpr }),
          // 一致は getPositiveNews と同じ新着順。
          orderBy: sql`${nagiNews.indexedAt} desc`,
          distance: noDistance,
        }
      : mode === "semantic"
        ? semanticConditions({
            embedding,
            q,
            embeddingCol: nagiNews.embedding,
            textExpr,
          })
        : {
            ...hybridConditions({
              embedding,
              q,
              embeddingCol: nagiNews.embedding,
              textExpr,
            }),
            distance: noDistance,
          };
  if (!conditions) {
    // Ollama 不通で意味検索ができない。気まぐれだけ空にして一致検索は生かす。
    return { items: [], botActor: await getBotActor(), hasMore: false };
  }
  // 気まぐれは相対しきい値で裾を切るのでページングせず打ち止め。
  const semantic = mode === "semantic";
  const rows = await db
    .select({
      news: nagiNews,
      approval: nagiNewsApprovals,
      actor: nagiActors,
      profile: nagiProfiles,
      semDistance: conditions.distance,
    })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(
      and(
        isNull(nagiNews.deletedAt),
        eq(nagiNewsApprovals.status, "approved"),
        eq(nagiNewsApprovals.newsCid, nagiNews.cid),
        hasTrustedSnapshot,
        or(eq(nagiNews.did, config.botDid), isNull(nagiActors.did), eq(nagiActors.status, "active")),
        ...(mutes.actors.length ? [notInArray(nagiNews.did, mutes.actors)] : []),
        conditions.match,
      ),
    )
    .orderBy(conditions.orderBy, sql`${nagiNews.uri} desc`)
    .limit(semantic ? SEMANTIC_LIMIT : opts.limit + 1)
    .offset(semantic ? 0 : offset);
  const page = semantic
    ? relativeCut(rows, (row) => Number(row.semDistance))
    : rows.slice(0, opts.limit);
  const hasMore = !semantic && rows.length > opts.limit;
  const [reactions, botActor] = await Promise.all([
    getReactionViews(
      page.map((row) => row.news.uri),
      opts.viewerDid,
    ),
    getBotActor(),
  ]);
  return {
    items: page.map((row) =>
      view(row, opts.lang, reactions.get(row.news.uri) ?? []),
    ),
    botActor,
    hasMore,
    cursor: hasMore ? encodeOffset(offset + opts.limit) : undefined,
  };
}

/** プロフィール用。14日制限なしで、現在も承認済みのニュースだけを返す。 */
export async function getApprovedNewsViews(
  uris: string[],
  lang: NewsLang,
  viewerDid?: string,
): Promise<Map<string, NewsView>> {
  const uniqueUris = [...new Set(uris)];
  if (!uniqueUris.length) return new Map();
  const mutes = await loadMutes(viewerDid);
  const rows = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals, actor: nagiActors, profile: nagiProfiles })
    .from(nagiNews)
    .innerJoin(
      nagiNewsApprovals,
      and(
        eq(nagiNewsApprovals.newsUri, nagiNews.uri),
        eq(nagiNewsApprovals.newsCid, nagiNews.cid),
      ),
    )
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(
      and(
        inArray(nagiNews.uri, uniqueUris),
        isNull(nagiNews.deletedAt),
        eq(nagiNewsApprovals.status, "approved"),
        hasTrustedSnapshot,
        or(eq(nagiNews.did, config.botDid), isNull(nagiActors.did), eq(nagiActors.status, "active")),
        ...(mutes.actors.length ? [notInArray(nagiNews.did, mutes.actors)] : []),
      ),
    );
  const reactions = await getReactionViews(
    rows.map((row) => row.news.uri),
    viewerDid,
  );
  return new Map(
    rows.map((row) => [
      row.news.uri,
      view(row, lang, reactions.get(row.news.uri) ?? []),
    ]),
  );
}

/** 引用は14日を過ぎても表示する。非表示・削除・CID不一致なら掲載終了プレースホルダー。 */
export async function getNewsQuoteViews(
  refs: Array<{ uri: string; cid: string }>,
  mutedActors: string[] = [],
): Promise<Map<string, NewsView>> {
  if (!refs.length) return new Map();
  const uris = [...new Set(refs.map((ref) => ref.uri))];
  const rows = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals, actor: nagiActors, profile: nagiProfiles })
    .from(nagiNews)
    .leftJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(inArray(nagiNews.uri, uris));
  const out = new Map<string, NewsView>();
  for (const ref of refs) {
    const row = rows.find(
      (candidate) =>
        candidate.news.uri === ref.uri &&
        candidate.approval?.newsCid === ref.cid,
    );
    const key = `${ref.uri}|${ref.cid}`;
    if (
      !row ||
      !row.approval ||
      row.approval.status !== "approved" ||
      row.news.deletedAt ||
      mutedActors.includes(row.news.did) ||
      (row.news.did !== config.botDid && row.actor !== null && row.actor.status !== "active") ||
      (row.news.did !== config.botDid &&
        (!row.approval.snapshotUrl ||
          !row.approval.snapshotTitleJa ||
          !row.approval.snapshotCreatedAt))
    ) {
      out.set(key, {
        uri: ref.uri,
        cid: ref.cid,
        articleId: "",
        url: "",
        title: "掲載終了",
        botComment: "",
        lang: "ja",
        createdAt: "",
        indexedAt: "",
        reactions: [],
        unavailable: true,
      });
    } else if (row.news.cid === ref.cid)
      out.set(key, view({ news: row.news, approval: row.approval }, "ja"));
    else if (
      row.approval.snapshotUrl &&
      row.approval.snapshotTitleJa &&
      row.approval.botCommentJa
    )
      out.set(key, {
        uri: ref.uri,
        cid: ref.cid,
        articleId: row.approval.snapshotArticleId ?? "",
        url: row.approval.snapshotUrl,
        title: row.approval.snapshotTitleJa,
        sourceName: row.approval.snapshotSourceName ?? undefined,
        sourceUrl: row.approval.snapshotSourceUrl ?? undefined,
        publishedAt: row.approval.snapshotPublishedAt?.toISOString(),
        botComment: row.approval.botCommentJa,
        lang: "ja",
        createdAt: row.approval.snapshotCreatedAt?.toISOString() ?? "",
        indexedAt: row.approval.reviewedAt.toISOString(),
        reactions: [],
        ...(row.news.did !== config.botDid
          ? {
              submittedBy: {
                did: row.news.did,
                handle: row.actor?.handle ?? row.news.did,
                ...(row.profile?.displayName
                  ? { displayName: row.profile.displayName }
                  : {}),
                ...(row.profile?.avatarCid
                  ? {
                      avatar: `/api/blob/${encodeURIComponent(row.news.did)}/${row.profile.avatarCid}`,
                    }
                  : {}),
              },
            }
          : {}),
      });
    else
      out.set(key, {
        uri: ref.uri,
        cid: ref.cid,
        articleId: "",
        url: "",
        title: "掲載終了",
        botComment: "",
        lang: "ja",
        createdAt: "",
        indexedAt: "",
        reactions: [],
        unavailable: true,
      });
  }
  return out;
}

/**
 * 全肯定ニュースの「動的枠」。ログインユーザーの興味ベクトルに近い承認済みニュースを返す。
 *
 * **items には混ぜない。** クライアントの未読判定が `items[0]` = 最新であることに
 * 依存しているため（news/unread.svelte.ts）、推薦は別フィールドで返して一覧の時系列を保つ。
 *
 * 一覧と違って14日制限は掛けない（searchNews と同じ扱い）。少し前の記事でも、
 * その人に近いなら拾い直す枠なので。
 */
export async function getRecommendedNews(opts: {
  viewerDid: string;
  lang: NewsLang;
  limit: number;
  /** 一覧の1ページ目に既に載っている URI。 */
  excludeUris: string[];
  mutes: MuteSet;
}): Promise<RecommendedNewsView[]> {
  if (opts.limit <= 0) return [];
  // 重心ではなく「自分の直近の投稿のいずれかとの最短距離」で採点する。
  // 平均を取ると全員に同じ記事が配られることを本番実測で確認している（nearestOwnPost 参照）。
  const dist = sql<number>`${nearestOwnPost(opts.viewerDid, nagiNews.embedding)}`;
  const rows = await db
    .select({
      news: nagiNews,
      approval: nagiNewsApprovals,
      actor: nagiActors,
      profile: nagiProfiles,
      semDistance: dist,
    })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(
      and(
        isNull(nagiNews.deletedAt),
        eq(nagiNewsApprovals.status, "approved"),
        eq(nagiNewsApprovals.newsCid, nagiNews.cid),
        hasTrustedSnapshot,
        or(
          eq(nagiNews.did, config.botDid),
          isNull(nagiActors.did),
          eq(nagiActors.status, "active"),
        ),
        isNotNull(nagiNews.embedding),
        sql`${dist} < ${embeddingProfile().semDistMax}`,
        ...(opts.mutes.actors.length
          ? [notInArray(nagiNews.did, opts.mutes.actors)]
          : []),
        ...(opts.excludeUris.length
          ? [notInArray(nagiNews.uri, opts.excludeUris)]
          : []),
      ),
    )
    .orderBy(sql`${dist} asc`, sql`${nagiNews.uri} desc`)
    .limit(opts.limit);
  // 裾を引きずるほど精度が落ちるので、検索と同じ相対しきい値で切る。
  const page = relativeCut(rows, (row) => Number(row.semDistance));
  if (!page.length) return [];
  const uris = page.map((row) => row.news.uri);
  const [reactions, reasons] = await Promise.all([
    getReactionViews(uris, opts.viewerDid),
    loadNewsReasons(opts.viewerDid, uris),
  ]);
  return page.map((row) => {
    const keyword = reasons.get(row.news.uri);
    return {
      ...view(row, opts.lang, reactions.get(row.news.uri) ?? []),
      ...(keyword ? { reason: { keyword } } : {}),
    };
  });
}
