import {
  db,
  nagiActors,
  nagiNews,
  nagiNewsApprovals,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import type {
  FeedItem,
  NewsView,
  Page,
  RecommendedNewsView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { config } from "../config.js";
import { ADULT_LABELS_ARRAY, decodeCursor, encodeCursor, getBotActor } from "./timeline.js";
import { viewerIsAdult } from "../services/ageAssurance.js";
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
import { loadNewsGenres, nearestOwnPost } from "./personalizedFeed.js";
import { embeddingProfile } from "@bsky-affirmative-bot/database";

export type NewsLang = "ja" | "en";

export const hasTrustedSnapshot = or(
  eq(nagiNews.did, config.botDid),
  and(
    isNotNull(nagiNewsApprovals.snapshotUrl),
    isNotNull(nagiNewsApprovals.snapshotTitleJa),
    isNotNull(nagiNewsApprovals.snapshotCreatedAt),
  ),
)!;

/**
 * 「公開してよい承認済みニュース」の条件。一覧・検索・プロフィール・パーマリンクが
 * 同じ集合を指すための唯一の定義。
 *
 * 以前は同じ形の where が3か所へ散らばっていて、`hiddenAt` の扱いだけが揃っていなかった。
 * 14日窓・ミュート・成人判定・並び順は呼び出し側ごとに違うのでここには入れない。
 */
export function approvedNewsConditions(opts: { actorJoined?: boolean } = {}): SQL[] {
  return [
    isNull(nagiNews.deletedAt),
    eq(nagiNewsApprovals.status, "approved"),
    // 管理者が隠した記事。hide は status も同時に落とすが、再公開時の onConflict が
    // status を戻しうるので、「隠した」という事実そのものを見る。
    isNull(nagiNewsApprovals.hiddenAt),
    eq(nagiNewsApprovals.newsCid, nagiNews.cid),
    hasTrustedSnapshot,
    // 停止・削除された利用者のニュースを落とす。nagiActors を join している呼び出し側でしか
    // 評価できないので、join しない索引経路は actorJoined:false で外す（あちらは bot 所有行
    // しか見ないため、この条件は常に真になる）。
    ...(opts.actorJoined === false
      ? []
      : [
          or(
            eq(nagiNews.did, config.botDid),
            isNull(nagiActors.did),
            eq(nagiActors.status, "active"),
          )!,
        ]),
  ];
}

/**
 * 未成年ビューアに見せない条件。投稿側の adultContentVisibility と同型で、
 * ニュースには self_labels が無いぶんだけ短い。判定待ち（moderation_version is null）も落とす。
 *
 * **索引経路では必ず isAdult=false を渡すこと。** 未認証のビューアに対して
 * viewerIsAdult は true を返す（ログイン前の公開閲覧を遅らせないための既定）ので、
 * クローラをそのまま通すと成人向けラベルの記事が検索結果に出る。
 */
export function newsAdultVisibility(isAdult: boolean): SQL[] {
  if (isAdult) return [];
  return [
    sql`${nagiNews.moderationVersion} is not null`,
    sql`not (${nagiNews.moderationLabels} && ${ADULT_LABELS_ARRAY})`,
  ];
}

// 検索は関連順のため offset ベースのページング（一覧の keyset とは別系統）。
const encodeOffset = (offset: number) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeOffset = (cursor?: string): number => {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/**
 * ニュース1件のビュー。年表（queries/chronicle.ts）も同じ変換を要るので export している。
 * **向こうで組み直さないこと** — スナップショットと PDS 値のフォールバック規則が2か所に
 * 分かれると、ユーザー投稿ニュースの編集が片方にだけ反映される。
 */
export function newsView(
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
  const image = safeHttpsUrl(row.approval.snapshotImageUrl);
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
    ...(image ? { image } : {}),
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

function safeHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export async function getPositiveNews(opts: {
  limit: number;
  cursor?: string;
  lang: NewsLang;
  viewerDid?: string;
}): Promise<Page<NewsView>> {
  const point = decodeCursor(opts.cursor);
  const [mutes, isAdult] = await Promise.all([
    loadMutes(opts.viewerDid),
    viewerIsAdult(opts.viewerDid),
  ]);
  const filters: any[] = [
    ...approvedNewsConditions(),
    ...newsAdultVisibility(isAdult),
    sql`${nagiNews.indexedAt} >= now() - interval '14 days'`,
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
      newsView(row, opts.lang, reactions.get(row.news.uri) ?? []),
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
        ...approvedNewsConditions(),
        ...newsAdultVisibility(await viewerIsAdult(opts.viewerDid)),
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
      newsView(row, opts.lang, reactions.get(row.news.uri) ?? []),
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
        ...approvedNewsConditions(),
        ...newsAdultVisibility(await viewerIsAdult(viewerDid)),
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
      newsView(row, lang, reactions.get(row.news.uri) ?? []),
    ]),
  );
}

/**
 * パーマリンクの rkey。`sha256(articleId).slice(0, 32)`（NagiNewsFeature.ts）なので
 * 必ずこの形。DBを引く前に弾き、URLの形をそのままクエリへ通さない。
 */
const NEWS_RKEY = /^[0-9a-f]{32}$/;

/**
 * 記事1件。`/news/<rkey>` のパーマリンク用。
 *
 * 既存の2本は流用できない —— getPositiveNews は14日窓を持ち、searchNews は
 * 既定の hybrid モードが Ollama の埋め込みに依存していて、落ちている間は空を返す。
 * パーマリンクはどちらの都合でも 404 になってはいけない。
 */
export async function getNewsItemByRkey(opts: {
  rkey: string;
  lang: NewsLang;
  viewerDid?: string;
}): Promise<{ news: NewsView; botActor?: FeedItem["author"] } | null> {
  if (!NEWS_RKEY.test(opts.rkey)) return null;
  const [mutes, isAdult] = await Promise.all([
    loadMutes(opts.viewerDid),
    viewerIsAdult(opts.viewerDid),
  ]);
  const rows = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals, actor: nagiActors, profile: nagiProfiles })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .leftJoin(nagiActors, eq(nagiActors.did, nagiNews.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiNews.did))
    .where(
      and(
        eq(nagiNews.rkey, opts.rkey),
        ...approvedNewsConditions(),
        ...newsAdultVisibility(isAdult),
        ...(mutes.actors.length ? [notInArray(nagiNews.did, mutes.actors)] : []),
      ),
    )
    // rkey は articleId のハッシュなので、同じ記事を bot と利用者の双方が持ちうる。
    // 並びを固定して、一度索引された URL が後から別の行を指さないようにする。
    .orderBy(asc(nagiNews.indexedAt), asc(nagiNews.uri))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const [reactions, botActor] = await Promise.all([
    getReactionViews([row.news.uri], opts.viewerDid),
    getBotActor(),
  ]);
  return {
    news: newsView(row, opts.lang, reactions.get(row.news.uri) ?? []),
    botActor,
  };
}

/**
 * 索引してよいニュースの列挙。クライアントのビルドが prerender の entries() と
 * sitemap を作るために使う。
 *
 * getPositiveNews との違いは意図的:
 * - **14日窓なし**。パーマリンクは公開し続ける
 * - **成人向けラベルを無条件で除外**。クローラに年齢確認は無い
 * - **botたん所有のみ**。利用者投稿のニュースには submittedBy（handle・表示名・アイコン）が
 *   付き、それは本人のPDS由来の識別情報なので、検索公開のオプトイン（Stage 6）の対象
 * - **ミュートもビューアも見ない**。索引対象は誰から見ても同じ集合
 * - **リアクションを引かない**。ビルド時点の数はすぐ古くなるうえ、
 *   実際の表示はハイドレーション後にクライアントが取り直す
 */
export async function listIndexableNews(opts: {
  limit: number;
  cursor?: string;
  lang: NewsLang;
}): Promise<Page<NewsView>> {
  const point = decodeCursor(opts.cursor);
  const rows = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .where(
      and(
        eq(nagiNews.did, config.botDid),
        ...approvedNewsConditions({ actorJoined: false }),
        ...newsAdultVisibility(false),
        ...(point
          ? [
              or(
                lt(nagiNews.indexedAt, point[0]),
                and(eq(nagiNews.indexedAt, point[0]), lt(nagiNews.uri, point[1])),
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(nagiNews.indexedAt), desc(nagiNews.uri))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1)?.news;
  // プリレンダした HTML でも botたんのアイコンと表示名が出るように添える。
  // 無いと newsBotPost のフォールバック（アイコン無し）が静的HTMLへ焼き付く。
  const botActor = await getBotActor();
  return {
    items: page.map((row) => newsView(row, opts.lang, [])),
    botActor,
    hasMore: rows.length > opts.limit,
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(last.indexedAt, last.uri)
        : undefined,
  };
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
      out.set(key, newsView({ news: row.news, approval: row.approval }, "ja"));
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
  // **関心ジャンルが当たった記事だけを出す。** 理由は飾りではなく掲載条件。
  // 近い順に3件並べるだけだと、実測で大半が「近いが話題は無関係」な記事になり
  // （本番で判定200ペア中 一致12件）、「あなたに近いかも」という見出しが実態を伴わなかった。
  // 当たりが無ければセクションごと出さない。
  const matched = await loadNewsGenres(opts.viewerDid, null);
  const uris = [...matched.keys()].filter(
    (uri) => !opts.excludeUris.includes(uri),
  );
  if (!uris.length) return [];
  // 重心ではなく「自分の直近の投稿のいずれかとの最短距離」で並べる（nearestOwnPost 参照）。
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
        inArray(nagiNews.uri, uris),
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
        ...(opts.mutes.actors.length
          ? [notInArray(nagiNews.did, opts.mutes.actors)]
          : []),
      ),
    )
    .orderBy(sql`${dist} asc`, sql`${nagiNews.uri} desc`)
    .limit(opts.limit);
  const page = rows;
  if (!page.length) return [];
  const reactions = await getReactionViews(
    page.map((row) => row.news.uri),
    opts.viewerDid,
  );
  return page.map((row) => ({
    ...newsView(row, opts.lang, reactions.get(row.news.uri) ?? []),
    // uris は matched から作っているので、ここで必ずジャンルが取れる。
    reason: { genre: matched.get(row.news.uri)! },
  }));
}
