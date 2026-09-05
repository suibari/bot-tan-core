/**
 * 全肯定ニュースの「動的枠」。ログインユーザーの投稿に近い記事を選ぶための道具立て。
 *
 * 全肯定フィードにも同じ動的枠を入れていたが撤去した。母数が小さすぎて「選んでいる」と
 * 言える状態にならなかったため（本番実測で30日12件しか無く、固定枠8件を除いた残りから
 * 2件を拾うだけになっていた）。フィードは時系列＋1人1日1投稿に戻してある。
 *
 * 採点に重心（平均ベクトル）を使わない理由は nearestOwnPost のコメントを参照。
 */
import { db, nagiNewsReasons } from "@bsky-affirmative-bot/database";
import { and, eq, inArray, isNotNull, sql, type SQLWrapper } from "drizzle-orm";
import { viewerIsAdult } from "../services/ageAssurance.js";
import { loadMutes } from "./mutes.js";

/**
 * 動的枠に載せる投稿の鮮度。古い投稿が「あなたに近い」として延々と出続けるのを防ぐ。
 * 全肯定フィードの供給量に対して十分広い窓。
 */
const FEED_WINDOW_DAYS = 30;


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
 * 「おすすめの理由」。ローカルLLMが先に判定して nagi.news_reasons に置いたものを読むだけ。
 *
 * ここで距離計算も LLM 呼び出しもしない。前者は尺度が合わず嘘の理由が出るため、
 * 後者はリクエスト経路が詰まるため（保存してから判定、というモデレーションと同じ形）。
 * 未判定の記事は理由なしで出す。
 */
export async function loadNewsReasons(
  viewerDid: string,
  /** URI を絞る場合に渡す。null なら「当たったもの全部」。 */
  newsUris: string[] | null,
): Promise<Map<string, string>> {
  if (newsUris && !newsUris.length) return new Map();
  const rows = await db
    .select({
      newsUri: nagiNewsReasons.newsUri,
      keyword: nagiNewsReasons.keyword,
    })
    .from(nagiNewsReasons)
    .where(
      and(
        eq(nagiNewsReasons.did, viewerDid),
        isNotNull(nagiNewsReasons.keyword),
        ...(newsUris ? [inArray(nagiNewsReasons.newsUri, newsUris)] : []),
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
