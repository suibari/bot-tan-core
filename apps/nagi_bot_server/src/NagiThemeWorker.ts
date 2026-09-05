/**
 * 全肯定ニュースの動的枠に付ける「おすすめの理由：〜」を先に計算しておくワーカー。
 *
 * 2段構え:
 *  1. テーマ抽出 … 本人の投稿からローカルLLMが関心テーマを取り出し、
 *     nagi.actor_interest_keywords に source='theme' で入れる
 *  2. 突合       … 興味ベクトルに近い記事を数件だけ選び、テーマのどれに当たるかを
 *     ローカルLLMに判定させて nagi.news_reasons に置く
 *
 * リクエスト経路でLLMを呼ばないための前計算であることが要点。AppView は結果を読むだけ。
 *
 * ハッシュタグ由来のテーマ（source='hashtag'）も同じ表に入れる。本人が明示的に付けた語なので
 * LLM 抽出のテーマと併存させる。こちらは純SQLで、LLM の都合とは切り離してある。
 */
import {
  db,
  nagiActorInterestKeywords,
  nagiNewsReasons,
} from "@bsky-affirmative-bot/database";
import {
  extractActorThemes,
  matchNewsToThemes,
  MAX_MATCH_ARTICLES,
  THEME_SOURCE_POSTS,
} from "@bsky-affirmative-bot/bot-brain";
import { eq, sql } from "drizzle-orm";

/** 1 tick で面倒を見るユーザー数。LLM 呼び出しが1人あたり最大2回走る。 */
const BATCH_SIZE = 4;
const BUSY_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 5 * 60_000;
/** テーマを取り直す間隔。人の関心はそう速く変わらない。 */
const THEME_TTL_HOURS = 24;
/**
 * 突合をやり直す間隔。新しい記事が積まれるので、テーマより短くする。
 *
 * 新着記事に理由が付くのは最大でこの時間ぶん遅れる（ニュースの掲載自体が6時間スロットなので
 * 実質的に同じ周期）。理由が無い記事は理由なしで表示されるだけなので、遅れても壊れない。
 */
const REASON_TTL_HOURS = 6;
/** 動的枠を出すのに必要な埋め込み済み投稿数（personalizedFeed.ts と揃える）。 */
const MIN_PROBE_POSTS = 5;
/** 採点に使う自分の投稿の本数（personalizedFeed.ts と揃える）。 */
const PROBE_POSTS = 10;
/** テーマとして扱うのに最低限必要なハッシュタグの使用回数。1回だけの語は癖ではない。 */
const MIN_HASHTAG_POSTS = 2;
const MAX_HASHTAG_THEMES = 8;
const LOG_PREFIX = "[nagi-theme]";

/**
 * テーマが未生成、または TTL 切れのユーザー。
 * 投稿が少なすぎる人は動的枠自体が出ないので対象にしない。
 */
async function actorsNeedingThemes(limit: number): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(sql`
    select a.did
      from nagi.actors a
      left join (
        select did, max(updated_at) as updated_at
          from nagi.actor_interest_keywords
         group by did
      ) t on t.did = a.did
     where a.status = 'active'
       and (t.updated_at is null
            or t.updated_at < now() - interval '${sql.raw(String(THEME_TTL_HOURS))} hours')
       and (select count(*) from (
              select 1 from nagi.posts
               where did = a.did and deleted_at is null and embedding is not null
               limit ${MIN_PROBE_POSTS}) p) >= ${MIN_PROBE_POSTS}
     order by t.updated_at asc nulls first
     limit ${limit}
  `);
  return rows.map((row) => row.did);
}

/**
 * ハッシュタグ由来のテーマ。本人が明示的に付けた語なので LLM 抽出と併存させる。
 * こっそり投稿は数えない（こっそりの中身が理由として画面に出るのは意図に反する）。
 */
async function refreshHashtagThemes(did: string): Promise<void> {
  await db.execute(sql`
    insert into nagi.actor_interest_keywords (did, keyword, source, post_count, updated_at)
    select ${did}, tag, 'hashtag', n, now()
      from (
        select tag, count(*)::int as n
          from nagi.posts p, unnest(p.tags) as tag
         where p.did = ${did} and p.deleted_at is null and not p.kossori
         group by tag having count(*) >= ${MIN_HASHTAG_POSTS}
      ) counted
     order by n desc, tag asc
     limit ${MAX_HASHTAG_THEMES}
    on conflict (did, keyword) do nothing
  `);
}

async function refreshThemes(did: string): Promise<number> {
  const posts = await db.execute<{ text: string }>(sql`
    select text from nagi.posts
     where did = ${did}
       and deleted_at is null
       and not kossori
       and reply_parent_uri is null
     order by indexed_at desc
     limit ${THEME_SOURCE_POSTS}
  `);
  const themes = await extractActorThemes(posts.map((row) => row.text));
  await db.transaction(async (tx) => {
    // 取り直しなので古い行は消す（使わなくなったタグ・変わったテーマを落とす）。
    await tx
      .delete(nagiActorInterestKeywords)
      .where(eq(nagiActorInterestKeywords.did, did));
    if (themes.length)
      await tx
        .insert(nagiActorInterestKeywords)
        .values(
          themes.map((keyword) => ({
            did,
            keyword,
            source: "theme",
            updatedAt: new Date(),
          })),
        )
        // ハッシュタグと同じ語を抽出したときは、既にある hashtag 行を残す。
        .onConflictDoNothing();
    // テーマが変わったら理由は作り直し。古い理由が残ると、もう無い語を出しかねない。
    await tx.delete(nagiNewsReasons).where(eq(nagiNewsReasons.did, did));
  });
  await refreshHashtagThemes(did);
  return themes.length;
}

/** 突合が古い／未計算のユーザー。テーマを1つ以上持っている人だけが対象。 */
async function actorsNeedingReasons(limit: number): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(sql`
    select k.did
      from nagi.actor_interest_keywords k
      left join (
        select did, max(updated_at) as updated_at from nagi.news_reasons group by did
      ) r on r.did = k.did
     group by k.did, r.updated_at
    having r.updated_at is null
        or r.updated_at < now() - interval '${sql.raw(String(REASON_TTL_HOURS))} hours'
     order by r.updated_at asc nulls first
     limit ${limit}
  `);
  return rows.map((row) => row.did);
}

/**
 * そのユーザーの興味ベクトルに近い記事を数件選び、テーマとの突合結果を保存する。
 *
 * 候補の選び方は AppView の getRecommendedNews と同じ「重心に近い順」。実際に表示される
 * 3件はこの上位に含まれるので、多めに取っておけば取りこぼしはほぼ無い。
 */
async function refreshReasons(did: string): Promise<number> {
  const keywords = await db
    .select({ keyword: nagiActorInterestKeywords.keyword })
    .from(nagiActorInterestKeywords)
    .where(eq(nagiActorInterestKeywords.did, did));
  const themes = keywords.map((row) => row.keyword);
  if (!themes.length) return 0;

  // AppView の getRecommendedNews と同じ採点（自分の直近投稿との最短距離）で並べる。
  // 実際に表示される3件はこの上位に含まれるので、多めに取れば取りこぼしはほぼ無い。
  const articles = await db.execute<{ uri: string; title: string }>(sql`
    with probe as (
      select embedding from nagi.posts
       where did = ${did} and deleted_at is null and embedding is not null
       order by indexed_at desc limit ${PROBE_POSTS}
    )
    select n.uri, coalesce(a.snapshot_title_ja, n.title_ja) as title
      from nagi.news n
      join nagi.news_approvals a
        on a.news_uri = n.uri and a.news_cid = n.cid and a.status = 'approved'
     where n.deleted_at is null
       and n.embedding is not null
     order by (select min(probe.embedding <=> n.embedding) from probe) asc
     limit ${MAX_MATCH_ARTICLES}
  `);
  if (!articles.length) return 0;

  const matches = await matchNewsToThemes(
    themes,
    articles.map((row) => row.title),
  );
  const now = new Date();
  // 当たらなかったものも NULL で残す。「判定済み」と「未判定」を区別しないと毎回引き直す。
  await db
    .insert(nagiNewsReasons)
    .values(
      articles.map((row, i) => ({
        did,
        newsUri: row.uri,
        keyword: matches[i] ?? null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [nagiNewsReasons.did, nagiNewsReasons.newsUri],
      set: {
        keyword: sql`excluded.keyword`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return matches.filter(Boolean).length;
}

let running = false;

export function startNagiThemeWorker() {
  if (running) return;
  running = true;

  const tick = async (): Promise<number> => {
    let worked = 0;
    for (const did of await actorsNeedingThemes(BATCH_SIZE)) {
      try {
        const n = await refreshThemes(did);
        console.info(LOG_PREFIX, { event: "themes", did, themes: n });
        worked++;
      } catch (error) {
        // Ollama 不通など。テーマが無ければ理由が出ないだけで、推薦自体は動く。
        console.error(`[ERROR]${LOG_PREFIX} themes did=${did}`, error);
      }
    }
    for (const did of await actorsNeedingReasons(BATCH_SIZE)) {
      try {
        const n = await refreshReasons(did);
        console.info(LOG_PREFIX, { event: "reasons", did, matched: n });
        worked++;
      } catch (error) {
        console.error(`[ERROR]${LOG_PREFIX} reasons did=${did}`, error);
      }
    }
    return worked;
  };

  const loop = async () => {
    let worked = 0;
    try {
      worked = await tick();
    } catch (error) {
      console.error(`[ERROR]${LOG_PREFIX}`, error);
    }
    setTimeout(
      () => void loop(),
      worked > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
    );
  };

  void loop();
}
