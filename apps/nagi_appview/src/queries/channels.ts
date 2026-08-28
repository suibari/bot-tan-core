import {
  db,
  nagiChannels,
  nagiChannelSubscriptions,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import type { ChannelView } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import {
  fetchPostRows,
  getTimeline,
  hydratePostViews,
} from "./timeline.js";
import {
  embedQuery,
  hybridConditions,
  lexicalMatch,
  relativeCut,
  SEMANTIC_LIMIT,
  semanticConditions,
  type SearchMode,
} from "./hybridSearch.js";
import { channelView, iso } from "./channelView.js";
import { isChannelMuted, loadMutes } from "./mutes.js";
import { loadSubscribedAmong } from "./channelSubscriptions.js";

// 検索は関連順のため offset ベースのページング（tag/一覧の keyset とは別系統）。
const encodeOffset = (offset: number) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeOffset = (cursor?: string): number => {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/** 活動順ソート用の下限（投稿ゼロの CH はここに沈む）。 */
const EPOCH = "1970-01-01T00:00:00.000Z";

/** 各 CH の最新投稿時刻（活動順・過疎判定に再利用できる）。削除済み投稿は除く。 */
const lastPostSub = db
  .select({
    channelUri: nagiPosts.channelUri,
    lastPostAt: sql<Date>`max(${nagiPosts.indexedAt})`.as("last_post_at"),
  })
  .from(nagiPosts)
  .where(isNull(nagiPosts.deletedAt))
  .groupBy(nagiPosts.channelUri)
  .as("lp");

/** ソートキー: COALESCE(最新投稿, epoch)。投稿のある CH ほど上位、無い CH は epoch で末尾。 */
const sortAt = sql<Date>`coalesce(${lastPostSub.lastPostAt}, ${EPOCH}::timestamptz)`;

export type ChannelDirectoryView = "trend" | "list" | "mine";

/**
 * 過去5日以内に、CH主でもbotたんでもない人の有効な投稿があればトレンド。
 * 状態を保存せず投稿を真実源にするため、初投稿で即昇格し、最終投稿から5日後に自動で戻る。
 * reply も取り込み時に channel_uri が非正規化されるため、CH内の会話として判定に含まれる。
 */
export const channelIsTrending = sql<boolean>`exists (
  select 1
  from nagi.posts as trend_post
  where trend_post.channel_uri = "nagi"."channels"."uri"
    and trend_post.deleted_at is null
    and trend_post.did <> "nagi"."channels"."did"
    and trend_post.did <> ${config.botDid}
    and trend_post.record_created_at >= now() - interval '5 days'
)`;

export function channelDirectoryConditions(
  view: ChannelDirectoryView,
  viewerDid?: string,
) {
  if (view === "trend") return [channelIsTrending];
  if (!viewerDid) return [sql`false`];
  if (view === "mine") return [eq(nagiChannels.did, viewerDid)];
  return [
    inArray(
      nagiChannels.uri,
      db
        .select({ uri: nagiChannelSubscriptions.channelUri })
        .from(nagiChannelSubscriptions)
        .where(eq(nagiChannelSubscriptions.ownerDid, viewerDid)),
    ),
  ];
}

export function prioritizeTrending<T extends { trending: boolean }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => Number(b.trending) - Number(a.trending));
}

const encodeCursor = (sort: string, uri: string) =>
  Buffer.from(JSON.stringify([sort, uri])).toString("base64url");
const decodeCursor = (cursor?: string): [string, string] | undefined => {
  try {
    const [s, u] = JSON.parse(Buffer.from(cursor!, "base64url").toString());
    return [s, u];
  } catch {
    return undefined;
  }
};

export async function getChannels(opts: {
  limit: number;
  cursor?: string;
  viewerDid?: string;
  view?: ChannelDirectoryView;
}) {
  const view = opts.view ?? "trend";
  // 本人向け一覧を認証なしで全件へフォールバックさせない。ルートでも400にするが、
  // クエリ単体の呼び出しでも fail closed にしておく。
  if ((view === "list" || view === "mine") && !opts.viewerDid)
    return { channels: [], hasMore: false };
  const point = decodeCursor(opts.cursor);
  const mutes = await loadMutes(opts.viewerDid);
  const filters: any[] = [
    isNull(nagiChannels.deletedAt),
    ...channelDirectoryConditions(view, opts.viewerDid),
  ];
  // ミュートした CH は一覧に出さない（URL 直打ちの getChannel だけは通す）。
  if (mutes.channels.length)
    filters.push(notInArray(nagiChannels.uri, mutes.channels));
  if (point)
    filters.push(
      sql`(${sortAt}, ${nagiChannels.uri}) < (${point[0]}::timestamptz, ${point[1]})`,
    );
  const rows = await db
    .select({
      uri: nagiChannels.uri,
      cid: nagiChannels.cid,
      did: nagiChannels.did,
      name: nagiChannels.name,
      description: nagiChannels.description,
      bannerCid: nagiChannels.bannerCid,
      pinnedPostUri: nagiChannels.pinnedPostUri,
      pinnedPostCid: nagiChannels.pinnedPostCid,
      recordCreatedAt: nagiChannels.recordCreatedAt,
      indexedAt: nagiChannels.indexedAt,
      lastPostAt: lastPostSub.lastPostAt,
    })
    .from(nagiChannels)
    .leftJoin(lastPostSub, eq(lastPostSub.channelUri, nagiChannels.uri))
    .where(and(...filters))
    .orderBy(sql`${sortAt} desc`, sql`${nagiChannels.uri} desc`)
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  // 一覧では「参加中」バッジのためだけに使う。未認証には付けない。
  const subscribed = opts.viewerDid
    ? await loadSubscribedAmong(
        opts.viewerDid,
        page.map((row) => row.uri),
      )
    : undefined;
  return {
    channels: page.map((row) => ({
      ...channelView(row),
      ...(subscribed ? { viewerSubscribed: subscribed.has(row.uri) } : {}),
    })),
    cursor:
      rows.length > opts.limit && last
        ? encodeCursor(iso(last.lastPostAt ?? EPOCH), last.uri)
        : undefined,
    hasMore: rows.length > opts.limit,
  };
}

/**
 * チャンネルの自然文検索。name+description を対象に意味検索(pgvector)+trgm 語彙一致の
 * ハイブリッド。出力形状は getChannels と同じ。
 */
export async function searchChannels(opts: {
  q: string;
  limit: number;
  cursor?: string;
  viewerDid?: string;
  mode?: SearchMode;
}) {
  const q = opts.q.trim();
  const mode: SearchMode = opts.mode ?? "hybrid";
  const offset = decodeOffset(opts.cursor);
  const [embedding, mutes] = await Promise.all([
    // exact は埋め込みを使わないので Ollama 往復ごと省く。
    mode === "exact" ? Promise.resolve(null) : embedQuery(q),
    loadMutes(opts.viewerDid),
  ]);
  const textExpr = sql`coalesce(${nagiChannels.name}, '') || ' ' || coalesce(${nagiChannels.description}, '')`;
  const noDistance = sql<number>`0`;
  const conditions =
    mode === "exact"
      ? {
          match: lexicalMatch({ q, textExpr }),
          // 一致は活動順（getChannels と同じ sortAt）。スコアで並べる理由がない。
          orderBy: sql`${sortAt} desc`,
          distance: noDistance,
        }
      : mode === "semantic"
        ? semanticConditions({
            embedding,
            q,
            embeddingCol: nagiChannels.embedding,
            textExpr,
          })
        : {
            ...hybridConditions({
              embedding,
              q,
              embeddingCol: nagiChannels.embedding,
              textExpr,
            }),
            distance: noDistance,
          };
  if (!conditions) {
    // Ollama 不通で意味検索ができない。気まぐれだけ空にして一致検索は生かす。
    return { channels: [], hasMore: false };
  }
  // 気まぐれは相対しきい値で裾を切るのでページングせず打ち止め。
  const semantic = mode === "semantic";
  const rows = await db
    .select({
      uri: nagiChannels.uri,
      cid: nagiChannels.cid,
      did: nagiChannels.did,
      name: nagiChannels.name,
      description: nagiChannels.description,
      bannerCid: nagiChannels.bannerCid,
      pinnedPostUri: nagiChannels.pinnedPostUri,
      pinnedPostCid: nagiChannels.pinnedPostCid,
      recordCreatedAt: nagiChannels.recordCreatedAt,
      indexedAt: nagiChannels.indexedAt,
      lastPostAt: lastPostSub.lastPostAt,
      trending: channelIsTrending,
      semDistance: conditions.distance,
    })
    .from(nagiChannels)
    .leftJoin(lastPostSub, eq(lastPostSub.channelUri, nagiChannels.uri))
    .where(
      and(
        isNull(nagiChannels.deletedAt),
        ...(mutes.channels.length
          ? [notInArray(nagiChannels.uri, mutes.channels)]
          : []),
        conditions.match,
      ),
    )
    .orderBy(
      // semantic は relativeCut が距離順を前提にするため、足切り後にJS側でトレンドを上げる。
      ...(semantic ? [] : [sql`${channelIsTrending} desc`]),
      conditions.orderBy,
      sql`${nagiChannels.uri} desc`,
    )
    .limit(semantic ? SEMANTIC_LIMIT : opts.limit + 1)
    .offset(semantic ? 0 : offset);
  const relevant = semantic
    ? relativeCut(rows, (row) => Number(row.semDistance))
    : rows.slice(0, opts.limit);
  const page = semantic ? prioritizeTrending(relevant) : relevant;
  const hasMore = !semantic && rows.length > opts.limit;
  return {
    channels: page.map(channelView),
    cursor: hasMore ? encodeOffset(offset + opts.limit) : undefined,
    hasMore,
  };
}

/**
 * Composer の #チャンネル候補。キー入力ごとに呼ばれるため埋め込みは生成せず、
 * name の完全一致・前方一致・部分一致の順で軽量に返す。同名 CH も URI ごとに残す。
 *
 * 活動順（lastPostAt）は一覧と違って lastPostSub を JOIN しない。あれは nagi.posts 全体を
 * GROUP BY する集約なので、打鍵のたびに投稿テーブル全走査になってしまう。ここでは絞り込みに
 * 残った候補ごとの相関サブクエリにして nagi_posts_channel_idx(channel_uri, indexed_at) を効かせる。
 */
export async function searchChannelsTypeahead(opts: {
  q: string;
  limit: number;
  viewerDid?: string;
}) {
  const q = opts.q.trim().toLowerCase();
  const mutes = await loadMutes(opts.viewerDid);
  const loweredName = sql<string>`lower(${nagiChannels.name})`;
  // 外側の列は必ず修飾して書く。select 句の中で ${nagiChannels.uri} を使うと drizzle が
  // 非修飾の "uri" を出し、nagi.posts にも uri 列があるため p.uri に解決されてしまう。
  const lastPostAt = sql<Date | null>`(
      select max(p.indexed_at) from nagi.posts p
       where p.channel_uri = "nagi"."channels"."uri" and p.deleted_at is null
    )`.as("last_post_at");
  const rows = await db
    .select({
      uri: nagiChannels.uri,
      cid: nagiChannels.cid,
      did: nagiChannels.did,
      name: nagiChannels.name,
      description: nagiChannels.description,
      bannerCid: nagiChannels.bannerCid,
      pinnedPostUri: nagiChannels.pinnedPostUri,
      pinnedPostCid: nagiChannels.pinnedPostCid,
      recordCreatedAt: nagiChannels.recordCreatedAt,
      indexedAt: nagiChannels.indexedAt,
      lastPostAt,
      trending: channelIsTrending,
    })
    .from(nagiChannels)
    .where(
      and(
        isNull(nagiChannels.deletedAt),
        ...(mutes.channels.length
          ? [notInArray(nagiChannels.uri, mutes.channels)]
          : []),
        sql`position(${q} in ${loweredName}) > 0`,
      ),
    )
    .orderBy(
      sql`case when ${loweredName} = ${q} then 0 when position(${q} in ${loweredName}) = 1 then 1 else 2 end`,
      sql`position(${q} in ${loweredName})`,
      sql`${channelIsTrending} desc`,
      // 出力列名で参照して相関サブクエリの二重評価を避ける。投稿ゼロの CH は末尾（一覧の
      // coalesce(..., EPOCH) と同じ並び）。
      sql`last_post_at desc nulls last`,
      sql`${nagiChannels.uri} desc`,
    )
    .limit(Math.min(10, opts.limit));
  return {
    channels: rows.map(channelView),
    hasMore: false,
  };
}

export async function getChannel(
  uri: string,
  viewerDid?: string,
): Promise<ChannelView | null> {
  const rows = await db
    .select({
      uri: nagiChannels.uri,
      cid: nagiChannels.cid,
      did: nagiChannels.did,
      name: nagiChannels.name,
      description: nagiChannels.description,
      bannerCid: nagiChannels.bannerCid,
      pinnedPostUri: nagiChannels.pinnedPostUri,
      pinnedPostCid: nagiChannels.pinnedPostCid,
      recordCreatedAt: nagiChannels.recordCreatedAt,
      indexedAt: nagiChannels.indexedAt,
      lastPostAt: lastPostSub.lastPostAt,
    })
    .from(nagiChannels)
    .leftJoin(lastPostSub, eq(lastPostSub.channelUri, nagiChannels.uri))
    .where(and(eq(nagiChannels.uri, uri), isNull(nagiChannels.deletedAt)))
    .limit(1);
  if (!rows[0]) return null;
  // ミュート済みでも URL 直打ちなら開ける（プロフィールと同じ方針）。その画面で解除できるよう
  // viewerMuted だけ返す。ミュートは非公開情報なので、あくまで本人のリクエストにしか付かない。
  // 購読状態も同じく非公開情報なので、認証されたビューアにしか付けない。
  const [muted, subscribed] = await Promise.all([
    isChannelMuted(viewerDid, uri),
    viewerDid
      ? loadSubscribedAmong(viewerDid, [uri]).then((set) => set.has(uri))
      : Promise.resolve(false),
  ]);
  const channel: ChannelView = {
    ...channelView(rows[0]),
    ...(muted ? { viewerMuted: true } : {}),
    ...(viewerDid ? { viewerSubscribed: subscribed } : {}),
  };
  if (!rows[0].pinnedPostUri) return channel;
  const [pinnedPost] = await hydratePostViews(
    await fetchPostRows([rows[0].pinnedPostUri]),
    viewerDid,
  );
  return pinnedPost &&
    !pinnedPost.deleted &&
    pinnedPost.channel?.uri === uri
    ? { ...channel, pinnedPost }
    : channel;
}

/**
 * CH タイムライン。channelOnly に関係なく当該 CH の投稿を全部（返信も）出す。
 * こっそりだけは本人以外に見せない（getTimeline の kossoriVisibility が効く）。
 */
export function getChannelTimeline(opts: {
  uri: string;
  limit: number;
  cursor?: string;
  viewerDid?: string;
  /** media はメディアグリッド用。画像付き投稿だけを投稿単位で返す。 */
  filter?: "posts" | "media";
}) {
  const media = opts.filter === "media";
  return getTimeline({
    limit: opts.limit,
    cursor: opts.cursor,
    viewerDid: opts.viewerDid,
    channelUri: opts.uri,
    ...(media ? { filter: "media" as const } : {}),
    // グリッドは1画像1タイルなので、スレッドの代表1件に畳む会話グループ化は使わない。
    // 畳むと同じスレッドの2枚目以降の画像が落ちてしまう。
    group: !media,
  });
}
