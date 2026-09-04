import { embeddingProfile, embedSearchQuery } from "@bsky-affirmative-bot/database";
import { and, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * 意味検索の距離しきい値（cosine 距離 = 1 - 類似度）。
 *
 * **この値に「関連/無関連を選り分ける」能力はない。** 3000件×27クエリの実測では、
 * 関連ヒットと無関連ヒットの距離分布がどのモデルでもほぼ重なる
 * （arctic 0.480/0.511、arctic-q 0.666/0.707、qwen3 0.403/0.404 ＝ 関連 p50/無関連 p50）。
 * 実際に品質を決めているのは SEMANTIC_LIMIT の打ち止めとランキングそのもの。
 * したがってここは**関連を取りこぼさない側**に置く（QUERY_PREFIX ありで 0.80 なら関連 100% 残存、
 * 0.75 では 95% まで落ちる）。詳細は docs/evaluations/embedding/summary.md。
 *
 * QUERY_PREFIX を変えたら**必ず一緒に**動かすこと（下記参照）。
 */
export const semDistMax = (): number => embeddingProfile().semDistMax;
/**
 * クエリ接頭辞。arctic-embed v2.0 は「クエリ側だけ query: を付ける」設計（文書側は素のまま）。
 *
 * かつてここには「Ollama の snowflake-arctic-embed2 は接頭辞を実装しておらず、付けても
 * ランキング不変・スコアのみ低下」と書いてあったが、**2026-09-04 の実測でこれは誤りと判明した**。
 * 接頭辞ありで nDCG@10 は 0.366 → 0.548、固有名詞カテゴリは 0.214 → 0.356 に上がり、
 * 「ワルプルギス」「まどマギ」はどちらも nDCG@10 1.000（＝満点）になる。
 * 文書側の再埋め込みは不要（クエリ側だけの話なので既存の埋め込みをそのまま使える）。
 *
 * 当時「効かない」と見えた原因は SEM_DIST_MAX。接頭辞は距離スケール全体を約 +0.19 押し上げる
 * （関連ヒットの距離中央値 0.480 → 0.666）ため、0.65 のままだと top-10 の 162/270 を
 * 絶対ガードが切り落とし、改善が閾値の裏に隠れる。
 * **接頭辞と SEM_DIST_MAX / ACTOR_SEM_DIST_MAX は必ずセットで動かすこと。**
 *
 * 既定が空文字なのは env 未設定の既存環境を壊さないため。運用値は .env.example を参照。
 *
 * 接頭辞の適用そのものは packages/database の embedSearchQuery() が持つ（botMemory RAG と
 * 共有するため）。ここに定数を置き直さないこと。
 */
// 意味スコアと語彙スコアの重み（意味を主・語彙を補完）。
const SEM_WEIGHT = 0.7;
const LEX_WEIGHT = 0.3;
// Ollama 不通時（埋め込みなし）の語彙のみモードで足切りする trgm 類似度。
const LEX_ONLY_MIN_SIM = 0.1;

/**
 * 検索の出し分け。UI の 🔍一致 / botたんの気まぐれ の2セクションに対応する。
 * hybrid は mode 未指定時の従来挙動（タイプアヘッド等が依存）。
 */
export type SearchMode = "exact" | "semantic" | "hybrid";

/**
 * 検索クエリを埋め込む。空文字や Ollama 不通なら null（呼び出し側は語彙のみにフォールバック）。
 *
 * `expand` は略称→正式名称の別名展開（「まどマギ」→「まどマギ 魔法少女まどか☆マギカ」）。
 * LLM 生成が1回入って約0.8秒かかるので、**あいまい検索（semantic）でだけ有効にする**。
 * タイプアヘッドが通る hybrid や一致検索では付けないこと。
 * 効果と設計判断は packages/database/src/queryExpansion.ts と
 * docs/evaluations/embedding-semantic/ を参照。
 */
export async function embedQuery(
  q: string,
  opts: { expand?: boolean } = {},
): Promise<number[] | null> {
  return embedSearchQuery(q, opts);
}

/**
 * 意味検索(pgvector) + trgm 語彙一致のハイブリッド条件を組み立てる共通ヘルパ。
 * 投稿・ユーザー・チャンネル・ニュースで、対象の embedding 列・テキスト式だけ差し替えて使い回す。
 * 返り値の `orderBy` はスコア降順のみ（各呼び出し側で一意キーの tiebreak を付け足すこと）。
 */
export function hybridConditions(opts: {
  embedding: number[] | null;
  q: string;
  /** cosine 近傍に使う embedding 列。 */
  embeddingCol: SQLWrapper;
  /** ILIKE / trgm similarity に使うテキスト式（列でも `coalesce(a,'')||' '||coalesce(b,'')` でも可）。 */
  textExpr: SQLWrapper;
}): { match: SQL; orderBy: SQL } {
  const { embedding, q, embeddingCol, textExpr } = opts;
  const like = `%${q}%`;

  if (embedding) {
    const vec = sql`${`[${embedding.join(",")}]`}::vector`;
    const dist = sql`(${embeddingCol} <=> ${vec})`;
    const match = or(
      and(sql`${embeddingCol} is not null`, sql`${dist} < ${semDistMax()}`),
      sql`${textExpr} ilike ${like}`,
    )!;
    const semScore = sql`case when ${embeddingCol} is not null then 1 - ${dist} else 0 end`;
    const lexScore = sql`similarity(${textExpr}, ${q})`;
    const orderBy = sql`(${SEM_WEIGHT} * (${semScore}) + ${LEX_WEIGHT} * (${lexScore})) desc`;
    return { match, orderBy };
  }

  // Ollama 不通/未設定: 語彙のみで検索。
  const match = or(
    sql`${textExpr} ilike ${like}`,
    sql`similarity(${textExpr}, ${q}) > ${LEX_ONLY_MIN_SIM}`,
  )!;
  const orderBy = sql`similarity(${textExpr}, ${q}) desc`;
  return { match, orderBy };
}

/**
 * 一致検索（🔍セクション）の条件。本文に語がそのまま含まれるものだけを拾う。
 * 並び順はここでは決めず、呼び出し側が新着順など安定した順序を付ける。
 * 埋め込みを一切使わないので Ollama が落ちていても素通しで動く。
 */
export function lexicalMatch(opts: { q: string; textExpr: SQLWrapper }): SQL {
  return sql`${opts.textExpr} ilike ${`%${opts.q}%`}`;
}

/**
 * あいまい検索（botたんの気まぐれ）の1ページ件数。ここは「近いものを少しだけ見せる」枠なので
 * ページングせず打ち止めにする。裾を引きずるほど精度が落ちるため上限自体が品質装置。
 */
export const SEMANTIC_LIMIT = 10;

/**
 * 相対しきい値のマージン。「最良ヒットの距離 + これ」を超えたら切る。
 *
 * SEM_DIST_MAX と同じく**選別能力はない**。実測ではどのマージンでも
 * 「関連の残存率 ≒ 無関連の通過率」で、両者を分けられない
 * （arctic-q の 0.08 で関連 76%/無関連 90%、0.12 で 99%/98%）。
 * 事実上ここは「1クエリあたり何件返すか」の調整つまみであり、
 * 距離スケールがモデルごとに違う以上、モデルを替えたら必ず測り直すこと。
 * 取りこぼしのほうが害が大きいので（SEMANTIC_LIMIT が上限を押さえているため）緩めに置く。
 */
const semRelMargin = (): number => embeddingProfile().semRelMargin;

/**
 * 距離昇順で取得済みの行を、先頭（最良）からの相対距離で切る。
 * SEM_DIST_MAX の絶対ガードと併用する二段構え: 絶対値で明らかな無関連を落とし、
 * 相対値でクエリごとの「どこまでが仲間か」を決める。
 */
export function relativeCut<T>(
  rows: T[],
  distanceOf: (row: T) => number | null | undefined,
): T[] {
  const best = rows.length ? distanceOf(rows[0]) : null;
  if (best === null || best === undefined || !Number.isFinite(best)) return rows;
  const limit = best + semRelMargin();
  const cut = rows.findIndex((row) => {
    const d = distanceOf(row);
    return d !== null && d !== undefined && Number.isFinite(d) && d > limit;
  });
  return cut === -1 ? rows : rows.slice(0, cut);
}

/**
 * あいまい検索（botたんの気まぐれ）の条件。cosine 近傍のみで拾い、一致セクションと排他に
 * するため ILIKE ヒット（＝語がそのまま入っている行）は除外する。これで2セクション間に
 * 重複が湧かない。
 * `distance` は relativeCut にかけるため呼び出し側の select に含めること。
 * embedding が null（Ollama 不通/未設定）なら null を返す＝呼び出し側は空結果を返すこと。
 */
export function semanticConditions(opts: {
  embedding: number[] | null;
  q: string;
  embeddingCol: SQLWrapper;
  textExpr: SQLWrapper;
  /** 既定は semDistMax()。プロフィールのように距離感が違う対象だけ差し替える。 */
  distMax?: number;
}): { match: SQL; orderBy: SQL; distance: SQL<number> } | null {
  const { embedding, q, embeddingCol, textExpr } = opts;
  if (!embedding) return null;

  const vec = sql`${`[${embedding.join(",")}]`}::vector`;
  const dist = sql<number>`(${embeddingCol} <=> ${vec})`;
  const match = and(
    sql`${embeddingCol} is not null`,
    sql`${dist} < ${opts.distMax ?? semDistMax()}`,
    sql`${textExpr} not ilike ${`%${q}%`}`,
  )!;
  return { match, orderBy: sql`${dist} asc`, distance: dist };
}
