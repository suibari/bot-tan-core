import {
  db,
  nagiActors,
  nagiPostScores,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  and,
  desc,
  eq,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { config } from "../config.js";
import {
  buildSearchFeedItems,
  getBotActor,
  postSelection,
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
import { loadMutes, muteVisibility } from "./mutes.js";

const encodeCursor = (offset: number) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeCursor = (cursor?: string): number => {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

export type { SearchMode };

/**
 * mode ごとの絞り込み条件と並び順。null は「意味検索が使えない（Ollama 不通）」を表し、
 * 呼び出し側は空結果を返す。orderBy には一意キーの tiebreak を付けない（呼び出し側で uri desc）。
 * distance は semantic のときだけ意味を持つ（他モードは 0 固定で行の型を揃えるためのダミー）。
 */
function buildConditions(
  mode: SearchMode,
  embedding: number[] | null,
  q: string,
): { match: SQL; orderBy: SQL; distance: SQL<number> } | null {
  const noDistance = sql<number>`0`;
  if (mode === "exact") {
    // 一致は語が入っていること自体が根拠なので、スコア順ではなく共有TLと同じ新着順にする。
    // (indexed_at, uri) の nagi_posts_timeline_idx にそのまま乗る。
    return {
      match: lexicalMatch({ q, textExpr: nagiPosts.text }),
      orderBy: desc(nagiPosts.indexedAt),
      distance: noDistance,
    };
  }
  if (mode === "semantic") {
    return semanticConditions({
      embedding,
      q,
      embeddingCol: nagiPosts.embedding,
      textExpr: nagiPosts.text,
    });
  }
  return {
    ...hybridConditions({
      embedding,
      q,
      embeddingCol: nagiPosts.embedding,
      textExpr: nagiPosts.text,
    }),
    distance: noDistance,
  };
}

/**
 * 自然文キーワード検索（NL検索の土台）。共有タイムラインと同じ可視性（削除・こっそり・CH限定・
 * bot返信のグルーピング）を適用し、結果は getTimeline と同じ FeedItem 形状で返す。
 *
 * mode で拾い方だけを差し替える（可視性・join・整形は3モード共通）:
 *   exact    … 本文に語が入っているものだけ・新着順。埋め込み不要なので Ollama に依存しない。
 *   semantic … 意味が近いものだけ・距離昇順。exact と排他（語を含むものは除外）。
 *   hybrid   … 意味0.7＋語彙0.3の従来の1本（mode 未指定時の後方互換）。
 *
 * ランキング順のためページングは offset ベース（cursor に offset を base64 で載せる）。
 */
export async function searchPostsByText(opts: {
  q: string;
  limit: number;
  cursor?: string;
  viewerDid?: string;
  mode?: SearchMode;
}) {
  const q = opts.q.trim();
  const mode: SearchMode = opts.mode ?? "hybrid";
  const offset = decodeCursor(opts.cursor);
  const [embedding, mutes] = await Promise.all([
    // exact は埋め込みを使わないので Ollama 往復ごと省く。
    // 展開は約0.8秒かかるので、あいまい検索の枠でだけ通す。hybrid はタイプアヘッドが
    // 使う経路なので付けない。
    mode === "exact"
      ? Promise.resolve(null)
      : embedQuery(q, { expand: mode === "semantic" }),
    loadMutes(opts.viewerDid),
  ]);
  const viewerMatch = opts.viewerDid
    ? sql`${nagiPosts.did} = ${opts.viewerDid}`
    : sql`false`;
  const threadRootViewerMatch = opts.viewerDid
    ? sql`thread_root.did = ${opts.viewerDid}`
    : sql`false`;
  // 共有TLと同じ可視性フィルタ（getTimeline の !actorDid && !channelUri 経路を踏襲）。
  const visibility = [
    isNull(nagiPosts.deletedAt),
    // botたんの返信は元投稿にまとめるため単独では出さない。
    or(ne(nagiPosts.did, config.botDid), isNull(nagiPosts.replyParentUri)),
    // ミュート。条件の組み立ては getTimeline と共通（規則がズレないよう mutes.ts に集約）。
    ...muteVisibility(mutes, { actors: true, channels: true }),
    // こっそり/CH限定はスレッドルートが所有。未解決の返信は非共有側へ倒す。
    sql`
      case
        when ${nagiPosts.replyRootUri} is null
          then not ${nagiPosts.channelOnly} and (not ${nagiPosts.kossori} or ${viewerMatch})
        else coalesce((
          select not thread_root.channel_only and (not thread_root.kossori or ${threadRootViewerMatch})
          from nagi.posts as thread_root
          where thread_root.uri = ${nagiPosts.replyRootUri}
            and thread_root.deleted_at is null
        ), false)
      end
    `,
  ];

  const conditions = buildConditions(mode, embedding, q);
  if (!conditions) {
    // Ollama 不通で意味検索ができない。あいまいセクションだけ空にして、一致検索は生かす。
    return { items: [], botActor: await getBotActor(), hasMore: false };
  }
  const { match, orderBy, distance } = conditions;
  // 気まぐれは相対しきい値で裾を切るので、ページングせず SEMANTIC_LIMIT で打ち止めにする。
  const semantic = mode === "semantic";
  const take = semantic ? SEMANTIC_LIMIT : opts.limit + 1;

  const rows = await db
    .select({ ...postSelection, semDistance: distance })
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(and(...visibility, match))
    .orderBy(orderBy, sql`${nagiPosts.uri} desc`)
    .limit(take)
    .offset(semantic ? 0 : offset);

  const page = semantic
    ? relativeCut(rows, (row) => Number(row.semDistance))
    : rows.slice(0, opts.limit);
  const [items, botActor] = await Promise.all([
    buildSearchFeedItems(page, opts.viewerDid, mutes),
    getBotActor(),
  ]);
  const hasMore = !semantic && rows.length > opts.limit;
  return {
    items,
    botActor,
    cursor: hasMore ? encodeCursor(offset + opts.limit) : undefined,
    hasMore,
  };
}
