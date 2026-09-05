/**
 * 全肯定フィード・全肯定ニュースの「動的枠」。
 *
 * 時系列の固定枠はそのまま残し、**自分の直近の投稿のいずれかに cosine で近いもの**を混ぜる。
 * 投稿がまだ無い新規ユーザーは候補ゼロになり、自然に全固定枠へ落ちる。
 *
 * 採点に重心（平均ベクトル）を使わない理由は nearestOwnPost のコメントを参照。
 *
 * **可視性はここで書き直さない。** 投稿の候補は timelineVisibilityFilters をそのまま使う。
 * こっそり・ミュート・成人向け・bot返信除外のどれか1つでもズレると、隠れているべき投稿が
 * 動的枠から漏れる。
 */
import {
  db,
  embeddingProfile,
  nagiNewsReasons,
  nagiActors,
  nagiPostScores,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  and,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { viewerIsAdult } from "../services/ageAssurance.js";
import { loadMutes, type MuteSet } from "./mutes.js";
import {
  buildFeedItems,
  getTimeline,
  postSelection,
  timelineVisibilityFilters,
  type PostRow,
} from "./timeline.js";

/**
 * 動的枠に載せる投稿の鮮度。古い投稿が「あなたに近い」として延々と出続けるのを防ぐ。
 * 全肯定フィードの供給量に対して十分広い窓。
 */
const FEED_WINDOW_DAYS = 30;

/**
 * 距離の絶対ガード。hybridSearch と同じ値を使う。
 *
 * hybridSearch.ts が実測付きで書いているとおり **しきい値そのものに関連/無関連を選り分ける
 * 能力はない**。ここでのガードは「明らかに遠いものを出さない」ためだけのもので、
 * 品質を決めているのは差し込み件数の少なさ（1ページに数件）である。
 */
const distMax = () => embeddingProfile().semDistMax;

/**
 * 採点に使う「自分の投稿」の本数。
 *
 * 本番実測: 直近10件で多様度は頭打ちになり、20件・50件に増やしても改善しない。
 * 少ないほうがプランナにも優しいので10件で止める。
 */
const PROBE_POSTS = 10;

/**
 * 動的枠を選ぶのに最低限必要な自分の埋め込み済み投稿数。
 * これを下回る人は候補ゼロ＝全固定枠になる。
 */
const MIN_PROBE_POSTS = 5;

/**
 * 「自分の直近の投稿のうち、いちばん近いものとの距離」を返す SQL 式。
 *
 * **重心（平均）を取ってはいけない。** 本番実測では、投稿100件の平均ベクトルは
 * 埋め込み空間の中心付近に寄ってしまい、結果として「いちばん中心に近い記事」が
 * 全員に配られた: ニュース上位3枠の多様度は 26.4%（24人×3枠=72枠を19記事が占有し、
 * 1記事が19人に配られた）。平均をやめて最近傍で採点すると 54.2%（最多共有8人）まで改善する。
 * フィード側も 60.3% → 67.6%。
 *
 * リアクションした投稿は probe に混ぜない。人気投稿へ反応が集中するぶん probe が
 * 人によらず似通い、多様度が 45.1% → 42.2% に下がることを実測した。
 *
 * この派生表は viewer にしか依存しないので、Postgres は1度だけ評価して使い回す。
 */
const nearestOwnPost = (viewerDid: string, target: SQLWrapper) => sql`(
  select min(probe.embedding <=> ${target})
    from (
      select embedding from nagi.posts
       where did = ${viewerDid}
         and deleted_at is null
         and embedding is not null
       order by indexed_at desc
       limit ${PROBE_POSTS}
    ) probe
)`;

/** 動的枠を出せるだけの材料があるか。無ければ全固定枠へ落とす。 */
export async function hasEnoughProbePosts(viewerDid?: string): Promise<boolean> {
  if (!viewerDid) return false;
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from nagi.posts
       where did = ${viewerDid} and deleted_at is null and embedding is not null
       limit ${PROBE_POSTS}
    ) t`);
  return Number(rows[0]?.n ?? 0) >= MIN_PROBE_POSTS;
}

export { nearestOwnPost };

/**
 * 全肯定フィードの動的枠の候補。時系列側とまったく同じ可視性条件で引き、
 * 興味ベクトルに近い順に返す。
 *
 * `offset` はページを跨いだ重複を避けるための送り。距離順は決定的なので、
 * 同じ興味ベクトルであれば 2 ページ目は 1 ページ目の続きになる。
 */
export async function pickAffirmationRecommendations(opts: {
  viewerDid: string;
  limit: number;
  /** 同じページの時系列枠に既に載っている URI。 */
  excludeUris: string[];
  offset: number;
  mutes: MuteSet;
  isAdult: boolean;
}): Promise<PostRow[]> {
  if (opts.limit <= 0) return [];
  const dist = nearestOwnPost(opts.viewerDid, nagiPosts.embedding);
  const filters = timelineVisibilityFilters(
    { viewerDid: opts.viewerDid, affirmation: true },
    {
      mutes: opts.mutes,
      muteActors: opts.mutes.actors.length > 0,
      muteChannels: opts.mutes.channels.length > 0,
      isAdult: opts.isAdult,
    },
  );
  filters.push(
    isNotNull(nagiPosts.embedding),
    // 自分の投稿を「あなたに近い」として見せ返さない。重心が自分の投稿から作られている以上、
    // これが無いと動的枠が自分の投稿で埋まる。
    ne(nagiPosts.did, opts.viewerDid),
    sql`${nagiPosts.indexedAt} >= now() - interval '${sql.raw(String(FEED_WINDOW_DAYS))} days'`,
    sql`${dist} < ${distMax()}`,
  );
  if (opts.excludeUris.length)
    filters.push(notInArray(nagiPosts.uri, opts.excludeUris));

  return db
    .select(postSelection)
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
    .where(and(...filters))
    .orderBy(sql`${dist} asc`, sql`${nagiPosts.uri} desc`)
    .limit(opts.limit)
    .offset(opts.offset);
}

/**
 * 動的枠を時系列の列へ差し込む。位置は `everyNth` 件ごと（0-indexed で everyNth-1, 2*everyNth-1 …）。
 * 動的枠が足りなければあるぶんだけ差し込む。**時系列の順序は変えない。**
 */
export function interleave<T>(base: T[], dynamic: T[], everyNth: number): T[] {
  if (!dynamic.length) return base;
  const out: T[] = [];
  const queue = [...dynamic];
  for (let i = 0; i < base.length; i++) {
    out.push(base[i]);
    if ((i + 1) % everyNth === 0 && queue.length) out.push(queue.shift()!);
  }
  // 時系列が差し込み位置に届かないほど短いページでは、末尾に付ける。
  out.push(...queue);
  return out;
}

/**
 * 全肯定フィード専用のカーソル。時系列カーソル（encodeCursor の文字列）と動的枠の送りを束ねる。
 *
 * encodeCursor / decodeCursor は多数の呼び出し元が共有しているので触らない。
 * 旧形式（＝素の時系列カーソル）が来たら動的枠の送りを 0 として解釈する。
 */
export const encodeAffirmationCursor = (base: string, dynOffset: number) =>
  Buffer.from(JSON.stringify({ b: base, d: dynOffset })).toString("base64url");

export const decodeAffirmationCursor = (
  cursor?: string,
): { base?: string; dynOffset: number } => {
  if (!cursor) return { dynOffset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.b === "string"
    )
      return {
        base: parsed.b,
        dynOffset: Number.isInteger(parsed.d) && parsed.d >= 0 ? parsed.d : 0,
      };
  } catch {
    // 旧形式のカーソルは JSON 配列なので、そのまま時系列カーソルとして通す。
  }
  return { base: cursor, dynOffset: 0 };
};

/**
 * 「おすすめの理由」。ローカルLLMが先に判定して nagi.news_reasons に置いたものを読むだけ。
 *
 * ここで距離計算も LLM 呼び出しもしない。前者は尺度が合わず嘘の理由が出るため、
 * 後者はリクエスト経路が詰まるため（保存してから判定、というモデレーションと同じ形）。
 * 未判定の記事は理由なしで出す。
 */
export async function loadNewsReasons(
  viewerDid: string,
  newsUris: string[],
): Promise<Map<string, string>> {
  if (!newsUris.length) return new Map();
  const rows = await db
    .select({
      newsUri: nagiNewsReasons.newsUri,
      keyword: nagiNewsReasons.keyword,
    })
    .from(nagiNewsReasons)
    .where(
      and(
        eq(nagiNewsReasons.did, viewerDid),
        inArray(nagiNewsReasons.newsUri, newsUris),
      ),
    );
  return new Map(
    rows.flatMap((row) => (row.keyword ? [[row.newsUri, row.keyword]] : [])),
  );
}

/** ルート側で使う共通の下ごしらえ。材料が足りなければ null＝全固定枠。 */
export async function loadPersonalizationContext(viewerDid?: string) {
  if (!viewerDid) return null;
  if (!(await hasEnoughProbePosts(viewerDid))) return null;
  const [mutes, isAdult] = await Promise.all([
    loadMutes(viewerDid),
    viewerIsAdult(viewerDid),
  ]);
  return { mutes, isAdult };
}

/**
 * 何件ごとに動的枠を差し込むか。limit=10・動的枠2件なら 4件目と8件目に入る。
 */
const INTERLEAVE_EVERY = 3;
/** 1ページあたりの動的枠の割合（limit の 1/5）。 */
const DYNAMIC_RATIO = 5;

/**
 * 全肯定フィード（getAffirmation）本体。時系列の固定枠に動的枠を差し込んで返す。
 *
 * ページ全体の件数は limit のまま保つため、時系列側は limit - 動的枠ぶんだけ引く。
 * 時系列カーソルの進みが遅くなるだけで、投稿の取りこぼしは起きない。
 *
 * 動的枠が無い（未ログイン／興味ベクトル未生成／候補ゼロ）ときは、
 * 従来の getTimeline の戻り値と完全に同じものを返す。
 */
export async function getAffirmationFeed(opts: {
  limit: number;
  cursor?: string;
  viewerDid?: string;
}): Promise<Awaited<ReturnType<typeof getTimeline>>> {
  const { base, dynOffset } = decodeAffirmationCursor(opts.cursor);
  const context = await loadPersonalizationContext(opts.viewerDid);
  if (!context)
    return getTimeline({
      limit: opts.limit,
      cursor: base,
      viewerDid: opts.viewerDid,
      affirmation: true,
      group: false,
    });

  const dynamicCount = Math.floor(opts.limit / DYNAMIC_RATIO);
  const timeline = await getTimeline({
    limit: Math.max(1, opts.limit - dynamicCount),
    cursor: base,
    viewerDid: opts.viewerDid,
    affirmation: true,
    group: false,
    mutes: context.mutes,
  });

  const rows = await pickAffirmationRecommendations({
    viewerDid: opts.viewerDid!,
    limit: dynamicCount,
    // 同じページの時系列枠との重複だけをここで消す。前のページに出たものと重なる可能性は
    // 残るが、それを消すには見せた URI を全部カーソルへ積むことになる。クライアントの
    // Feed.loadMore が既読み込みぶんとの重複を feedKey で落とすので、そちらに任せる。
    excludeUris: timeline.items.map((item) => item.uri),
    offset: dynOffset,
    mutes: context.mutes,
    isAdult: context.isAdult,
  });
  if (!rows.length) return { ...timeline, cursor: nextCursor(timeline.cursor, dynOffset) };

  const dynamic = (
    await buildFeedItems(rows, opts.viewerDid, true, false, context.mutes)
  ).map((item) => ({ ...item, recommended: true as const }));

  return {
    ...timeline,
    items: interleave(timeline.items, dynamic, INTERLEAVE_EVERY),
    cursor: nextCursor(timeline.cursor, dynOffset + dynamic.length),
  };
}

const nextCursor = (base: string | undefined, dynOffset: number) =>
  base ? encodeAffirmationCursor(base, dynOffset) : undefined;
