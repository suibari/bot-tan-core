/**
 * 全肯定ニュースの動的枠に付ける「おすすめの理由：〜」を先に計算しておくワーカー。
 *
 * 2段構え:
 *  1. 関心抽出 … 本人の投稿からローカルLLMが具体テーマと広いジャンルを取り出し、
 *     プロフィール用の nagi.actor_interest_keywords と推薦用の
 *     nagi.actor_interest_genres に分けて入れる
 *  2. 突合     … 興味ベクトルに近い記事を数件だけ選び、関心ジャンルのどれに当たるかを
 *     ローカルLLMに判定させて nagi.news_reasons に置く
 *
 * リクエスト経路でLLMを呼ばないための前計算であることが要点。AppView は結果を読むだけ。
 *
 * ハッシュタグ由来のテーマ（source='hashtag'）も同じ表に入れる。本人が明示的に付けた語なので
 * LLM 抽出のテーマと併存させる。こちらは純SQLで、LLM の都合とは切り離してある。
 *
 * ## スケジューリングは「いつ試したか」で決める
 *
 * 進捗は nagi.actors の themes_checked_at / news_reasons_checked_at に書く。結果が空でも書く。
 * 「行が書けたか」で判定すると、テーマが1つも取れない人・記事が1件も無い状態が候補に残り続け、
 * BUSY_INTERVAL_MS の10秒間隔で永久に回る（本番で実際に起きた）。
 * LLM の当たり外れとスケジューリングは切り離しておくこと。
 */
import {
  db,
  nagiActorInterestGenres,
  nagiActorInterestKeywords,
  nagiActors,
  nagiNewsReasons,
} from "@bsky-affirmative-bot/database";
import {
  extractActorInterests,
  matchNewsToGenres,
  MAX_MATCH_ARTICLES,
  MIN_THEME_SOURCE_POSTS,
  MIN_THEME_SOURCE_TEXT_LENGTH,
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
 * テーマが未抽出、または TTL 切れのユーザー。
 *
 * 2つの条件が要る。動的枠自体が出ない人（埋め込み投稿が少ない）は対象にしても意味が無く、
 * 素材が足りない人（返信・こっそり・短文ばかり）は呼んでも必ず0件になるため。
 * 後者は refreshThemes / extractActorInterests と同じ数え方にしておくこと。
 */
async function actorsNeedingThemes(limit: number): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(sql`
    select a.did
      from nagi.actors a
     where a.status = 'active'
       and (a.themes_checked_at is null
            or a.themes_checked_at < now() - interval '${sql.raw(String(THEME_TTL_HOURS))} hours')
       and (select count(*) from (
              select 1 from nagi.posts
               where did = a.did and deleted_at is null and embedding is not null
               limit ${MIN_PROBE_POSTS}) p) >= ${MIN_PROBE_POSTS}
       and (select count(*) from (
              select 1 from nagi.posts
               where did = a.did
                 and deleted_at is null
                 and not kossori
                 and reply_parent_uri is null
                 and length(text) >= ${MIN_THEME_SOURCE_TEXT_LENGTH}
               limit ${MIN_THEME_SOURCE_POSTS}) s) >= ${MIN_THEME_SOURCE_POSTS}
     order by a.themes_checked_at asc nulls first
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
  const interests = await extractActorInterests(posts.map((row) => row.text));
  await db.transaction(async (tx) => {
    // 取り直しなので古い行は消す（使わなくなったタグ・変わったテーマを落とす）。
    await tx
      .delete(nagiActorInterestKeywords)
      .where(eq(nagiActorInterestKeywords.did, did));
    if (interests.themes.length)
      await tx
        .insert(nagiActorInterestKeywords)
        .values(
          interests.themes.map((keyword) => ({
            did,
            keyword,
            source: "theme",
            updatedAt: new Date(),
          })),
        )
        // ハッシュタグと同じ語を抽出したときは、既にある hashtag 行を残す。
        .onConflictDoNothing();
    await tx
      .delete(nagiActorInterestGenres)
      .where(eq(nagiActorInterestGenres.did, did));
    if (interests.genres.length)
      await tx
        .insert(nagiActorInterestGenres)
        .values(
          interests.genres.map((genre) => ({
            did,
            genre,
            updatedAt: new Date(),
          })),
        );
    // テーマが変わったら理由は作り直し。古い理由が残ると、もう無い語を出しかねない。
    await tx.delete(nagiNewsReasons).where(eq(nagiNewsReasons.did, did));
    // themes が空でも「試した」印は付ける。付けないと次の tick でまた選ばれる。
    // 理由は消したので、突合は未実施へ戻す。
    await tx
      .update(nagiActors)
      .set({ themesCheckedAt: new Date(), newsReasonsCheckedAt: null })
      .where(eq(nagiActors.did, did));
  });
  await refreshHashtagThemes(did);
  return interests.themes.length + interests.genres.length;
}

/** 突合が古い／未実施のユーザー。関心ジャンルを1つ以上持っている人だけが対象。 */
async function actorsNeedingReasons(limit: number): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(sql`
    select a.did
      from nagi.actors a
     where a.status = 'active'
       and (a.news_reasons_checked_at is null
            or a.news_reasons_checked_at < now() - interval '${sql.raw(String(REASON_TTL_HOURS))} hours')
       and exists (select 1 from nagi.actor_interest_genres g where g.did = a.did)
     order by a.news_reasons_checked_at asc nulls first
     limit ${limit}
  `);
  return rows.map((row) => row.did);
}

/**
 * そのユーザーの興味ベクトルに近い記事を数件選び、テーマとの突合結果を保存する。
 *
 * 候補の選び方は AppView の getRecommendedNews と同じ「直近投稿のどれかに近い順」。実際に表示される
 * 3件はこの上位に含まれるので、多めに取っておけば取りこぼしはほぼ無い。
 */
async function computeReasons(did: string): Promise<number> {
  const genreRows = await db
    .select({ genre: nagiActorInterestGenres.genre })
    .from(nagiActorInterestGenres)
    .where(eq(nagiActorInterestGenres.did, did));
  const genres = genreRows.map((row) => row.genre);
  if (!genres.length) return 0;

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

  const matches = await matchNewsToGenres(
    genres,
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
        genre: matches[i] ?? null,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [nagiNewsReasons.did, nagiNewsReasons.newsUri],
      set: {
        genre: sql`excluded.genre`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return matches.filter(Boolean).length;
}

/**
 * 突合を1人ぶん実行し、「試した」印を付ける。
 *
 * テーマが無い・記事が0件で1行も書けなかったときも印は付ける（付けないと次の tick で
 * また選ばれる）。例外時は付けない ＝ Ollama 不通などは次回に持ち越す。
 */
async function refreshReasons(did: string): Promise<number> {
  const matched = await computeReasons(did);
  await db
    .update(nagiActors)
    .set({ newsReasonsCheckedAt: new Date() })
    .where(eq(nagiActors.did, did));
  return matched;
}

let running = false;

export function startNagiThemeWorker() {
  if (running) return;
  running = true;

  /**
   * 戻り値は「成果があったか」。実行できただけでは busy 扱いにしない。
   * 空振りが busy を維持すると、間隔が10秒に張り付いたまま何も進まなくなる。
   */
  const tick = async (): Promise<number> => {
    let worked = 0;
    for (const did of await actorsNeedingThemes(BATCH_SIZE)) {
      try {
        const n = await refreshThemes(did);
        console.info(LOG_PREFIX, { event: "themes", did, themes: n });
        if (n > 0) worked++;
      } catch (error) {
        // Ollama 不通など。テーマが無ければ理由が出ないだけで、推薦自体は動く。
        console.error(`[ERROR]${LOG_PREFIX} themes did=${did}`, error);
      }
    }
    for (const did of await actorsNeedingReasons(BATCH_SIZE)) {
      try {
        const n = await refreshReasons(did);
        console.info(LOG_PREFIX, { event: "reasons", did, matched: n });
        if (n > 0) worked++;
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
