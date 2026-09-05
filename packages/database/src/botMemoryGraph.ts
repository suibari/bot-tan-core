/**
 * botたんの記憶をネットワークグラフとして公開するための集計。
 *
 * ## 何を出して、何を出さないか
 *
 * 出すのは **印象語のラベルと、その集計値だけ**。会話の本文・source_uri・source_id・
 * author_id・埋め込みベクトルは、この経路のどこにも現れない。document_id すら CTE の
 * 内側に閉じていて、返り値の型に存在しない。bot-tan.com の公開ページが読むので、
 * ここへ値を足すときは「それ単体で誰かの発言を復元できないか」を必ず考えること。
 *
 * 安全フィルタは getRecentBotMemoryImpressions と同じものを使う:
 * deleted_at is null / visibility='public' / source_type in IMPRESSION_SOURCE_TYPES /
 * impression_scans.content_hash = documents.content_hash（抽出後に本文が書き換わった、
 * あるいはこっそりへ付け替えられた分をここでもう一度弾く）。
 *
 * ## エッジは二層
 *
 * - 共起: 同じ会話に一緒に出た。実際に語られた関係
 * - 類似: ラベルごとの埋め込み重心の cosine 類似。語られていない意味的な近さ
 *
 * 重心も類似度も SQL の中で完結させる。120本 × 1024次元をテキストで JS に持ってくると
 * 1.5MB がワイヤに乗るし、JS 側で平均を取るには元の文書ベクトルを全部引く必要がある。
 */
import { sql } from "drizzle-orm";
import { IMPRESSION_SOURCE_TYPES } from "./botMemory.js";
import { db } from "./db.js";

/** 何日ぶんの会話を対象にするか。 */
export const BOT_MEMORY_GRAPH_MAX_WINDOW_DAYS = 365;
export { MAX_NODE_LIMIT as BOT_MEMORY_GRAPH_MAX_NODES };
const DEFAULT_WINDOW_DAYS = 365;

/**
 * 何ノードまで返すか。
 *
 * 実測（開発機 / pgvector 0.8.6 / 1200ラベル・4669文書の合成データ）:
 *
 *   ノード数   クエリ    ペイロード   描画(1400x950)
 *      120     135ms       59KB          60fps
 *      500     245ms      267KB          60fps
 *     1000    1242ms      558KB        約52fps
 *     1200    1792ms      678KB
 *
 * 超線形なのは類似エッジの総当たり（O(n^2) × 1024次元）だけで、ノード集計も共起も
 * ほぼ定数時間。**ただしこれは開発機の数字で、本番は Raspberry Pi**。既定を1000に
 * せず500に置いてあるのはそのため。上げる前に本番で測ること（`?nodes=` で試せる）。
 * 60秒キャッシュなので、1リクエストが数秒かかる設定にすると DB を踏み続ける。
 */
const DEFAULT_NODE_LIMIT = 500;
const MAX_NODE_LIMIT = 1200;

/**
 * **プライバシー上の必須ガードで、チューニングノブではない。**
 *
 * 裏付けが1文書しかないラベルは、その共起エッジと合わせると「ある人の、ある1回の
 * 会話に出てきた話題の集合」をそのまま復元してしまう。2件あれば別々の会話に現れた
 * ことになり、個人の1発言には還元されない。
 */
const MIN_OCCURRENCES = 2;

/**
 * ラベルの健全性チェック。
 *
 * word の抽出はLLM任せなので、まれに本文のフレーズを丸ごと返す。長い文字列は
 * それ自体が発言の断片なので落とす。ハンドル・DID・URL も同様。
 */
const MAX_LABEL_LENGTH = 40;
const UNSAFE_LABEL_PATTERN = /[@＠]|did:|https?:\/\/|\.[a-z]{2,}\//i;

const COOCCURRENCE_EDGE_LIMIT = 8000;

/**
 * 類似エッジのしきい値。
 *
 * **未較正の暫定値。** 同じ言語の雑談どうしは無関係でも cosine 0.6〜0.85 に乗るので、
 * 素朴に 0.5 にすると完全グラフになって何も読み取れなくなる。0.75 はその経験則から
 * 置いた出発点で、実データで測った値ではない（開発機の DB には埋め込み済みの記憶が
 * ない）。本番のグラフを一度見て、線が多すぎる／少なすぎるなら次の SQL で分布を見て
 * から動かすこと。ここだけ触れば効く。
 *
 *   select width_bucket(sim, 0, 1, 20) as bucket, count(*)
 *     from (select 1 - (a.centroid <=> b.centroid) as sim from ...) t group by 1;
 */
const SIMILARITY_THRESHOLD = 0.75;
const SIMILARITY_TOP_K = 4;
const SIMILARITY_EDGE_LIMIT = 6000;

/** 重心を取るときに1ラベルあたり読む文書数の上限。 */
const CENTROID_DOCS_PER_LABEL = 30;

/**
 * salience 未評価（NULL）のラベルに、順位付けのときだけ仮に置く値。
 *
 * salience は 0061 で足した列なので、それ以前の記憶はすべて NULL。coalesce(...,0)
 * にすると過去の記憶が丸ごと沈む。0 は「評価した結果 印象に残らなかった」であって
 * 未評価ではないので、中立値を仮置きする。JSON では null のまま返す。
 */
const NEUTRAL_SALIENCE = 50;

/** 鮮度の半減の効き方。90日で 1/e。 */
const FRESHNESS_DECAY_DAYS = 90;

export type BotMemoryGraphNodeKind = "work" | "word";
export type BotMemoryGraphRelation = "recommended" | "liked" | "discussed";

export interface BotMemoryGraphNode {
  /** lower(label)。エッジが参照するキー。 */
  id: string;
  /** いちばん新しい会話での表記。 */
  label: string;
  /** active な読みがなければ null。 */
  spokenForm: string | null;
  kind: BotMemoryGraphNodeKind;
  relation: BotMemoryGraphRelation;
  /** 何件の会話に出たか。 */
  occurrences: number;
  latestAt: string;
  /** 印象度の最大値。未評価なら null（0 ではない）。 */
  salience: number | null;
  /** 裏付けのうち印象度が付いている件数。 */
  scoredCount: number;
}

export type BotMemoryGraphEdge =
  | { source: string; target: string; type: "cooccurrence"; weight: number }
  | { source: string; target: string; type: "similarity"; similarity: number };

export interface BotMemoryGraph {
  generatedAt: string;
  windowDays: number;
  /** 実際に返した件数の上限。 */
  nodeLimit: number;
  /** 公開できるラベルの総数。nodes.length との差が「入りきらなかった分」。 */
  totalLabels: number;
  /** 埋め込み重心が取れず、共起エッジだけになったときは false。 */
  similarityAvailable: boolean;
  nodes: BotMemoryGraphNode[];
  edges: BotMemoryGraphEdge[];
}

/** 集計クエリの生の行。JS 側の絞り込みと順位付けはここから始まる。 */
export interface BotMemoryGraphNodeRow {
  key: string;
  label: string;
  kind: string;
  relation: string;
  occurrences: number;
  latestAt: Date;
  salience: number | null;
  scoredCount: number;
}

export interface BotMemoryGraphPronunciationRow {
  surface: string;
  spokenForm: string | null;
}

export interface BotMemoryGraphCooccurrenceRow {
  source: string;
  target: string;
  weight: number;
}

export interface BotMemoryGraphSimilarityRow {
  source: string;
  target: string;
  similarity: number;
}

/** 上限を掛ける前の、公開してよいラベルの数。 */
export function countPublishableGraphLabels(
  rows: BotMemoryGraphNodeRow[],
  minOccurrences = MIN_OCCURRENCES,
): number {
  return rows.filter(
    (row) => row.occurrences >= minOccurrences && isPublishableGraphLabel(row.label),
  ).length;
}

/** ラベル自体が発言の断片になっていないか。 */
export function isPublishableGraphLabel(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed.length === 0) return false;
  if ([...trimmed].length > MAX_LABEL_LENGTH) return false;
  return !UNSAFE_LABEL_PATTERN.test(trimmed);
}

/**
 * 印象度・鮮度・出現数の積で並べる。
 *
 * 印象度だけだと同じ話題が延々と上位に居座り、鮮度だけだと昨日の雑談が
 * 何年ぶんの記憶を押しのける。出現数は対数で効かせて、頻出ラベルが
 * 印象度を無視して勝たないようにする。
 */
export function scoreBotMemoryGraphNode(
  row: Pick<BotMemoryGraphNodeRow, "salience" | "occurrences" | "latestAt">,
  now: Date,
): number {
  const ageDays = Math.max(0, (now.getTime() - row.latestAt.getTime()) / 86_400_000);
  const freshness = Math.exp(-ageDays / FRESHNESS_DECAY_DAYS);
  const salience = row.salience ?? NEUTRAL_SALIENCE;
  return salience * freshness * Math.log1p(row.occurrences);
}

/**
 * 生の集計行から、公開してよいノードだけを選んで整える。
 *
 * 読みは lower(surface) で突き合わせる。既存の getRecentBotMemoryImpressions は
 * surface = label の完全一致 join なので大文字小文字違いで読みを取りこぼすが、
 * こちらはラベルを畳んでいる以上、突き合わせも畳んだ側でやる。
 */
export function selectBotMemoryGraphNodes(
  rows: BotMemoryGraphNodeRow[],
  pronunciations: BotMemoryGraphPronunciationRow[] = [],
  options: { limit?: number; now?: Date; minOccurrences?: number } = {},
): BotMemoryGraphNode[] {
  const limit = Math.max(1, Math.min(MAX_NODE_LIMIT, options.limit ?? DEFAULT_NODE_LIMIT));
  const now = options.now ?? new Date();
  const minOccurrences = options.minOccurrences ?? MIN_OCCURRENCES;

  const spokenForms = new Map<string, string>();
  for (const row of pronunciations) {
    if (!row.spokenForm) continue;
    spokenForms.set(row.surface.toLowerCase(), row.spokenForm);
  }

  return rows
    .filter((row) =>
      row.occurrences >= minOccurrences && isPublishableGraphLabel(row.label)
    )
    .map((row) => ({ row, score: scoreBotMemoryGraphNode(row, now) }))
    // 同点は新しいほうを先に。順序が実行のたびに揺れると差分アニメーションが暴れる。
    .sort((a, b) =>
      b.score - a.score ||
      b.row.latestAt.getTime() - a.row.latestAt.getTime() ||
      a.row.key.localeCompare(b.row.key)
    )
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.key,
      label: row.label,
      spokenForm: spokenForms.get(row.key) ?? null,
      kind: row.kind === "work" ? "work" : "word",
      relation: (row.relation === "recommended" || row.relation === "liked")
        ? row.relation
        : "discussed",
      occurrences: row.occurrences,
      latestAt: row.latestAt.toISOString(),
      salience: row.salience,
      scoredCount: row.scoredCount,
    }));
}

function edgeKey(source: string, target: string): string {
  // ラベルには空白が入りうる（"Blue Archive"）ので、区切りに使えない。
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

/**
 * 二層のエッジを1本のリストに畳む。
 *
 * **既に共起で繋がっているペアには類似エッジを張らない。** 実際に一緒に語られた
 * ことのほうが強い情報だし、二重線は絵としても読めない。ノードに含まれない端点は
 * 落とす（クエリ側でも絞っているが、ここが最後の砦）。
 */
export function mergeBotMemoryGraphEdges(
  cooccurrence: BotMemoryGraphCooccurrenceRow[],
  similarity: BotMemoryGraphSimilarityRow[],
  nodeIds: Iterable<string>,
): BotMemoryGraphEdge[] {
  const known = new Set(nodeIds);
  const seen = new Set<string>();
  const edges: BotMemoryGraphEdge[] = [];

  for (const row of cooccurrence) {
    if (row.source === row.target) continue;
    if (!known.has(row.source) || !known.has(row.target)) continue;
    const key = edgeKey(row.source, row.target);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: row.source,
      target: row.target,
      type: "cooccurrence",
      weight: row.weight,
    });
  }

  for (const row of similarity) {
    if (row.source === row.target) continue;
    if (!known.has(row.source) || !known.has(row.target)) continue;
    const key = edgeKey(row.source, row.target);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: row.source,
      target: row.target,
      type: "similarity",
      similarity: Math.round(row.similarity * 10_000) / 10_000,
    });
  }

  return edges;
}

/*
 * Both of these go over as a single array parameter rather than an inlined
 * list. A thousand-element `in (...)` is a thousand bind parameters and a
 * linear scan per row; `= any($1::text[])` is one parameter the planner can
 * hash.
 */
const sourceTypes = [...IMPRESSION_SOURCE_TYPES];

/**
 * Drizzle は素の配列を `in (...)` 用のリストへ展開する（`(a, b, c)` になり
 * `record` として渡る）。`sql.param` で「これは1つの値」だと明示すると、
 * postgres.js が text[] として送る。
 */

/**
 * 公開してよい印象語だけを集めた土台。ノード・共起・重心の3クエリが共有する。
 *
 * ここを緩めると3つ全部が同時に緩む。逆に言えば、公開契約はこの1箇所で守られている。
 */
function eligibleCte(windowDays: number) {
  return sql`
    eligible as (
      select i.document_id,
             lower(i.label) as key,
             i.label,
             i.kind,
             i.relation,
             d.occurred_at,
             d.salience
        from affirmative_bot.bot_memory_impressions i
        join affirmative_bot.bot_memory_documents d
          on d.id = i.document_id
        join affirmative_bot.bot_memory_impression_scans s
          on s.document_id = d.id and s.content_hash = d.content_hash
       where d.deleted_at is null
         and d.visibility = 'public'
         and d.source_type = any(${sql.param(sourceTypes)}::text[])
         and d.occurred_at >= now() - (${windowDays}::int * interval '1 day')
    )
  `;
}

async function fetchNodeRows(windowDays: number): Promise<BotMemoryGraphNodeRow[]> {
  const rows = await db.execute<{
    key: string;
    label: string;
    kind: string;
    relation: string;
    occurrences: number;
    latest_at: Date;
    salience: number | null;
    scored_count: number;
  }>(sql`
    with ${eligibleCte(windowDays)}
    select key,
           (array_agg(label order by occurred_at desc))[1] as label,
           mode() within group (order by kind) as kind,
           mode() within group (order by relation) as relation,
           count(distinct document_id)::int as occurrences,
           max(occurred_at) as latest_at,
           max(salience)::int as salience,
           count(salience)::int as scored_count
      from eligible
     group by key
     limit 5000
  `);

  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    kind: row.kind,
    relation: row.relation,
    occurrences: Number(row.occurrences),
    latestAt: new Date(row.latest_at),
    salience: row.salience === null ? null : Number(row.salience),
    scoredCount: Number(row.scored_count),
  }));
}

async function fetchPronunciations(
  keys: string[],
): Promise<BotMemoryGraphPronunciationRow[]> {
  if (keys.length === 0) return [];
  const rows = await db.execute<{ surface: string; spoken_form: string | null }>(sql`
    select surface, spoken_form
      from affirmative_bot.bot_memory_pronunciations
     where status = 'active'
       and lower(surface) = any(${sql.param(keys)}::text[])
  `);
  return rows.map((row) => ({ surface: row.surface, spokenForm: row.spoken_form }));
}

async function fetchCooccurrenceEdges(
  windowDays: number,
  keys: string[],
): Promise<BotMemoryGraphCooccurrenceRow[]> {
  if (keys.length < 2) return [];
  const rows = await db.execute<{ source: string; target: string; weight: number }>(sql`
    with ${eligibleCte(windowDays)},
    picked as (
      select document_id, key from eligible where key = any(${sql.param(keys)}::text[])
    ),
    /*
     * **文書ごとにラベルを畳んでからペアを開く。** eligible どうしを直に自己結合
     * すると、組み合わせ空間が「全行 × 全行」になる。CTE の行数見積もりは 1 に
     * なるので planner は nested loop を選び、実測でノード1000件のとき3,390万行を
     * 結合条件で捨てて 4.6 秒かかっていた。畳めば空間は「1文書に付いたラベル数の
     * 2乗」に閉じる（実際は数個）。同じ結果で 20ms。
     */
    by_document as (
      select document_id, array_agg(distinct key) as keys from picked group by document_id
    )
    select a.key as source,
           b.key as target,
           count(*)::int as weight
      from by_document g,
           lateral unnest(g.keys) with ordinality as a(key, i),
           lateral unnest(g.keys) with ordinality as b(key, j)
     -- 対称な重複と自己ループをここで殺す
     where a.i < b.j and a.key < b.key
     group by a.key, b.key
     order by weight desc, source, target
     limit ${COOCCURRENCE_EDGE_LIMIT}
  `);
  return rows.map((row) => ({
    source: row.source,
    target: row.target,
    weight: Number(row.weight),
  }));
}

/**
 * pgvector の avg(vector) 集約が使えるか。
 *
 * 0.7 で入った集約なので、本番の pgvector バージョンが確認できない以上プローブする。
 * extversion を文字列比較するより、関数の存在を直接見るほうが正確。
 * プロセスごとに1回だけ。リクエストのたびに探らない。
 */
let vectorAvgProbe: Promise<boolean> | undefined;

function hasVectorAvg(): Promise<boolean> {
  vectorAvgProbe ??= db
    .execute<{ has_vector_avg: boolean }>(sql`
      select exists (
        select 1
          from pg_proc p
          join pg_type t on t.oid = p.prorettype
         where p.proname = 'avg' and t.typname = 'vector'
      ) as has_vector_avg
    `)
    .then((rows) => rows[0]?.has_vector_avg === true)
    .catch((error) => {
      console.error("[ERROR][MEMORY][GRAPH] avg(vector) probe failed:", error);
      return false;
    });
  return vectorAvgProbe;
}

/**
 * 埋め込み重心の材料。
 *
 * embedding_model を混ぜると重心が意味的に濁るので、対象期間でいちばん多く使われて
 * いるモデルに揃える。移行中は少数派が類似エッジを持たないが、ノードとしては出る。
 */
function centroidSourceCtes(windowDays: number, keys: string[]) {
  return sql`
    ${eligibleCte(windowDays)},
    dominant_model as (
      select d.embedding_model as model
        from eligible e
        join affirmative_bot.bot_memory_documents d on d.id = e.document_id
       where d.embedding is not null
         and d.embedding_model is not null
       group by d.embedding_model
       order by count(*) desc
       limit 1
    ),
    capped as (
      select key, embedding
        from (
          select e.key,
                 d.embedding,
                 row_number() over (
                   partition by e.key order by d.occurred_at desc
                 ) as rn
            from eligible e
            join affirmative_bot.bot_memory_documents d on d.id = e.document_id
           where e.key = any(${sql.param(keys)}::text[])
             and d.embedding is not null
             and d.embedding_model = (select model from dominant_model)
        ) ranked
       where rn <= ${CENTROID_DOCS_PER_LABEL}
    )
  `;
}

/** 重心の自己結合。n=120 なら 7,140 ペアで、Postgres の中なら数ミリ秒。 */
function similarityTail() {
  return sql`
    pairs as (
      select a.key as source,
             b.key as target,
             (1 - (a.centroid <=> b.centroid))::float8 as similarity
        from centroids a
        join centroids b on a.key < b.key
    ),
    ranked as (
      select source, target, similarity,
             row_number() over (partition by source order by similarity desc) as rn
        from pairs
       where similarity >= ${SIMILARITY_THRESHOLD}
    )
    select source, target, similarity
      from ranked
     where rn <= ${SIMILARITY_TOP_K}
     order by similarity desc, source, target
     limit ${SIMILARITY_EDGE_LIMIT}
  `;
}

async function fetchSimilarityEdges(
  windowDays: number,
  keys: string[],
): Promise<BotMemoryGraphSimilarityRow[] | null> {
  if (keys.length < 2) return [];

  const useVectorAvg = await hasVectorAvg();

  // pgvector >= 0.7 の avg(vector)。これが使えるなら1本で終わる。
  const centroids = useVectorAvg
    ? sql`centroids as (select key, avg(embedding) as centroid from capped group by key)`
    // 旧バージョン向け。次元ごとに平均して vector に組み直す。行数が
    // CENTROID_DOCS_PER_LABEL × 1024 倍に膨らむので数百ms かかるが、10分キャッシュの
    // 裏なら許容範囲。**JS 平均には落とさない**（ベクトルをプロセス外へ出さないため）。
    : sql`centroids as (
        select key,
               ('[' || string_agg(mean::text, ',' order by dim) || ']')::vector as centroid
          from (
            select key, ord as dim, avg(val)::float4 as mean
              from capped,
                   lateral unnest(embedding::real[]) with ordinality as u(val, ord)
             group by key, ord
          ) dims
         group by key
      )`;

  try {
    const rows = await db.execute<{ source: string; target: string; similarity: number }>(sql`
      with ${centroidSourceCtes(windowDays, keys)},
      ${centroids},
      ${similarityTail()}
    `);
    return rows.map((row) => ({
      source: row.source,
      target: row.target,
      similarity: Number(row.similarity),
    }));
  } catch (error) {
    // 類似エッジは付加価値なので、落ちても共起グラフは返す。
    console.error("[ERROR][MEMORY][GRAPH] similarity edges failed:", error);
    return null;
  }
}

export interface BotMemoryGraphOptions {
  windowDays?: number;
  nodeLimit?: number;
  now?: Date;
}

/**
 * 公開用の記憶グラフを1つ組み立てる。
 *
 * 重いのでキャッシュの裏に置くこと（publicApi.ts が10分）。
 */
export async function getBotMemoryGraph(
  options: BotMemoryGraphOptions = {},
): Promise<BotMemoryGraph> {
  const windowDays = Math.max(
    1,
    Math.min(BOT_MEMORY_GRAPH_MAX_WINDOW_DAYS, Math.floor(options.windowDays ?? DEFAULT_WINDOW_DAYS)),
  );
  const now = options.now ?? new Date();

  const nodeLimit = Math.max(
    1,
    Math.min(MAX_NODE_LIMIT, Math.floor(options.nodeLimit ?? DEFAULT_NODE_LIMIT)),
  );
  const nodeRows = await fetchNodeRows(windowDays);
  // 先にノードを確定させてから、そのキーだけでエッジを引く。エッジ側の
  // 探索範囲がノード数で頭打ちになるので、母集団が増えても費用が跳ねない。
  const provisional = selectBotMemoryGraphNodes(nodeRows, [], { limit: nodeLimit, now });
  const keys = provisional.map((node) => node.id);

  const [pronunciations, cooccurrence, similarity] = await Promise.all([
    fetchPronunciations(keys).catch((error) => {
      console.error("[ERROR][MEMORY][GRAPH] pronunciations failed:", error);
      return [] as BotMemoryGraphPronunciationRow[];
    }),
    fetchCooccurrenceEdges(windowDays, keys).catch((error) => {
      console.error("[ERROR][MEMORY][GRAPH] cooccurrence edges failed:", error);
      return [] as BotMemoryGraphCooccurrenceRow[];
    }),
    fetchSimilarityEdges(windowDays, keys),
  ]);

  const nodes = selectBotMemoryGraphNodes(nodeRows, pronunciations, { limit: nodeLimit, now });

  return {
    generatedAt: now.toISOString(),
    windowDays,
    nodeLimit,
    // 上限で切る前に、公開に耐えるラベルが何件あったか。
    totalLabels: countPublishableGraphLabels(nodeRows),
    similarityAvailable: similarity !== null,
    nodes,
    edges: mergeBotMemoryGraphEdges(cooccurrence, similarity ?? [], keys),
  };
}
