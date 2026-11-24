/**
 * おすすめフィード。仕様は nagi_client の openspec（FEED-10 / API-10）。
 *
 * 候補は「閲覧者の興味に近い」か「本人とbotたん以外の2人以上が反応した」トップ投稿。
 * 並びは時系列のまま、1人1日1件に絞る。
 *
 * ## 日付で区切った範囲を1回ずつ採点する
 *
 * dailyBestPerAuthor と同じ「自分より良い兄弟が居なければ代表」の NOT EXISTS で書くと、
 * 兄弟ごとに反応数と距離を計算し直すうえ、プランナが全投稿を走査する hash anti join を選ぶ
 * （開発DB 1万件で 450ms、投稿数に比例して遅くなる）。そこで JST の日単位で範囲を切り、
 * 範囲内の投稿を1回ずつ採点して窓関数で代表を選ぶ。足りなければ範囲を倍に広げる。
 *
 * 範囲は必ず日の境界で切り、カーソルはその後で当てる。カーソルの位置で日を途中から切ると、
 * 同じ日の新しい投稿が代表選びから抜けて、ページをまたいで代表が変わってしまう。
 */
import {
  db,
  embeddingProfile,
  nagiActors,
  nagiPostScores,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { config } from "../config.js";
import { viewerIsAdult } from "../services/ageAssurance.js";
import { loadMutes } from "./mutes.js";
import { hasEnoughProbePosts } from "./personalizedFeed.js";
import {
  buildFeedItems,
  decodeCursor,
  encodeCursor,
  getBotActor,
  postSelection,
  timelineVisibilityFilters,
} from "./timeline.js";

/**
 * 「反応が集まった」とみなす人数（投稿者本人とbotたんを除く）。
 * 2人では開発DBのほぼ全投稿が該当し、グローバルを1人1日1件に絞っただけになった。
 */
export const MIN_RECOMMEND_REACTORS = 5;

/** 興味の近さを測る材料の本数。ニュースの動的枠（personalizedFeed.ts）と揃える。 */
const PROBE_POSTS = 10;

/** 最初に採点する日数。足りなければ倍にしていく。 */
const INITIAL_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** その時刻を含む JST の日の始まり（UTC の Date）。 */
export function jstDayStart(date: Date): Date {
  return new Date(
    Math.floor((date.getTime() + JST_OFFSET_MS) / DAY_MS) * DAY_MS -
      JST_OFFSET_MS,
  );
}

/** 閲覧者の興味の材料。Nagi 投稿が足りる人は Nagi、足りない新規登録者は Bluesky 由来。 */
export type InterestSource = "nagi" | "bluesky" | "none";

export async function resolveInterestSource(
  viewerDid?: string,
): Promise<InterestSource> {
  if (!viewerDid || embeddingProfile().recommendDistMax < 0) return "none";
  if (await hasEnoughProbePosts(viewerDid)) return "nagi";
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from nagi.actor_interest_probes where did = ${viewerDid}`);
  return Number(rows[0]?.n ?? 0) > 0 ? "bluesky" : "none";
}

/**
 * 材料ベクトルを先に読み、VALUES の派生表として埋め込む。サブクエリのままだと
 * 投稿1件ごとに材料のインデックス走査をやり直す。
 */
async function loadProbes(
  viewerDid: string,
  source: InterestSource,
): Promise<SQL | undefined> {
  const from =
    source === "nagi"
      ? sql`(
          select embedding from nagi.posts
           where did = ${viewerDid}
             and deleted_at is null
             and embedding is not null
           order by indexed_at desc
           limit ${PROBE_POSTS}
        )`
      : sql`(
          select embedding from nagi.actor_interest_probes
           where did = ${viewerDid}
           order by position asc
           limit ${PROBE_POSTS}
        )`;
  const rows = await db.execute<{ embedding: string }>(
    sql`select embedding::text as embedding from ${from} as probe_source`,
  );
  if (!rows.length) return undefined;
  return sql`(values ${sql.join(
    rows.map((row) => sql`(${row.embedding}::vector)`),
    sql`, `,
  )})`;
}

/** 反応した人数（投稿者本人とbotたんを除く）。 */
const reactorsExpr = sql`(
  select count(distinct r.did)
    from nagi.reactions as r
   where r.subject_uri = ${nagiPosts.uri}
     and r.did <> ${nagiPosts.did}
     and r.did <> ${config.botDid}
)`;

/** 材料との最近傍距離。材料が無い・投稿の埋め込みが無いと NULL。 */
const distanceExpr = (probes?: SQL) =>
  probes
    ? sql`(select min(probe.embedding <=> ${nagiPosts.embedding}) from ${probes} as probe(embedding))`
    : sql`null::float8`;

type Window = { from: Date; until: Date };

/**
 * 範囲内の代表を新しい順に返す。良さの順は「興味に近い投稿の中で近い順 → 反応した人数 →
 * 新しさ」。閾値より遠い投稿どうしの距離の差には意味が無いので、遠い投稿は反応で比べる。
 * 範囲の両端は日の境界なので、各代表はその日の全投稿から選ばれている。
 */
async function rankWindow(opts: {
  filters: SQL[];
  probes?: SQL;
  window: Window;
  cursor?: [Date, string];
  limit: number;
}): Promise<{ uri: string; indexedAt: Date }[]> {
  const distMax = embeddingProfile().recommendDistMax;
  const near = opts.probes ? sql`coalesce(scored.distance <= ${distMax}, false)` : sql`false`;
  const candidate = sql`(scored.reactors >= ${MIN_RECOMMEND_REACTORS} or ${near})`;
  const cursor = opts.cursor
    ? sql`and (ranked.indexed_at, ranked.uri) < (${opts.cursor[0].toISOString()}::timestamptz, ${opts.cursor[1]})`
    : sql``;
  const rows = await db.execute<{ uri: string; indexed_at: string | Date }>(sql`
    select ranked.uri, ranked.indexed_at
      from (
        select scored.uri, scored.indexed_at,
               row_number() over (
                 partition by scored.did, (scored.indexed_at at time zone 'Asia/Tokyo')::date
                 order by ${near} desc,
                          case when ${near} then scored.distance end asc nulls last,
                          scored.reactors desc,
                          scored.indexed_at desc,
                          scored.uri desc
               ) as rank
          from (
            select ${nagiPosts.uri} as uri,
                   ${nagiPosts.did} as did,
                   ${nagiPosts.indexedAt} as indexed_at,
                   ${reactorsExpr} as reactors,
                   ${distanceExpr(opts.probes)} as distance
              from ${nagiPosts}
             where ${and(...opts.filters)}
               and ${nagiPosts.indexedAt} >= ${opts.window.from.toISOString()}::timestamptz
               and ${nagiPosts.indexedAt} < ${opts.window.until.toISOString()}::timestamptz
          ) as scored
         where ${candidate}
      ) as ranked
     where ranked.rank = 1 ${cursor}
     order by ranked.indexed_at desc, ranked.uri desc
     limit ${opts.limit}
  `);
  return rows.map((row) => ({
    uri: row.uri,
    indexedAt: new Date(row.indexed_at),
  }));
}

export async function getRecommended(opts: {
  limit: number;
  cursor?: string;
  viewerDid?: string;
}) {
  const [mutes, isAdult, source] = await Promise.all([
    loadMutes(opts.viewerDid),
    viewerIsAdult(opts.viewerDid),
    resolveInterestSource(opts.viewerDid),
  ]);
  const probes =
    opts.viewerDid && source !== "none"
      ? await loadProbes(opts.viewerDid, source)
      : undefined;
  const muteActors = mutes.actors.length > 0;
  const muteTags = mutes.tags.length > 0;
  // 可視性（こっそり・ミュート・成人向け・削除）はグローバルと同じ条件を共有する。
  const filters: SQL[] = timelineVisibilityFilters(
    { viewerDid: opts.viewerDid },
    { mutes, muteActors, muteTags, isAdult },
  );
  filters.push(
    ne(nagiPosts.did, config.botDid),
    // 返信は文脈なしに並べても読めないので、トップ投稿だけを候補にする。
    isNull(nagiPosts.replyParentUri),
  );
  // 自分の投稿は自分の興味に必ず近くなるので、おすすめには出さない。
  if (opts.viewerDid) filters.push(ne(nagiPosts.did, opts.viewerDid));

  const point = decodeCursor(opts.cursor);
  // カーソルの日の終わりまでを範囲に含める（日の途中で切らない）。
  const until = new Date(jstDayStart(point?.[0] ?? new Date()).getTime() + DAY_MS);
  const [oldest] = await db.execute<{ at: string | Date | null }>(
    sql`select min(${nagiPosts.indexedAt}) as at from ${nagiPosts}`,
  );
  const floor = oldest?.at ? jstDayStart(new Date(oldest.at)) : until;

  let days = INITIAL_WINDOW_DAYS;
  let ranked: { uri: string; indexedAt: Date }[] = [];
  for (;;) {
    const from = new Date(until.getTime() - days * DAY_MS);
    ranked = await rankWindow({
      filters,
      probes,
      window: { from, until },
      cursor: point,
      limit: opts.limit + 1,
    });
    if (ranked.length > opts.limit || from <= floor) break;
    days *= 2;
  }

  const pageUris = ranked.slice(0, opts.limit).map((row) => row.uri);
  const fetched = pageUris.length
    ? await db
        .select(postSelection)
        .from(nagiPosts)
        .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
        .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
        .leftJoin(nagiPostScores, eq(nagiPostScores.postUri, nagiPosts.uri))
        .where(inArray(nagiPosts.uri, pageUris))
    : [];
  const byUri = new Map(fetched.map((row) => [row.post.uri, row]));
  const page = pageUris.flatMap((uri) => {
    const row = byUri.get(uri);
    return row ? [row] : [];
  });
  const appliedMutes = {
    actors: muteActors ? mutes.actors : [],
    tags: muteTags ? mutes.tags : [],
  };
  const [items, botActor] = await Promise.all([
    buildFeedItems(page, opts.viewerDid, true, false, appliedMutes),
    getBotActor(),
  ]);
  const last = page.at(-1)?.post;
  const hasMore = ranked.length > opts.limit;
  return {
    items,
    botActor,
    cursor: hasMore && last ? encodeCursor(last.indexedAt, last.uri) : undefined,
    hasMore,
  };
}
