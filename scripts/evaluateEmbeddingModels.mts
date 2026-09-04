/**
 * 埋め込みモデルの検索精度を、同一コーパス・同一クエリで横並び比較する評価ハーネス。
 *
 * 発端は Nagi の意味検索の破綻。「ワルプルギス」で検索してもまどマギ／アニメ系が上位に
 * 来ず、無関係な投稿が並ぶ。現行は Ollama の snowflake-arctic-embed2（1024次元）1本。
 * ここで候補モデルを実データで測り、**明確な優位が出た場合のみ**置き換えへ進む。
 *
 * 使い方:
 *   # 何も叩かず、アーム構成・クエリ件数・必要な外部依存だけ表示
 *   pnpm embedding:evaluate
 *
 *   # 本実行（本番DBから read-only でコーパスを取り、全アームを測る）
 *   pnpm embedding:evaluate -- --run --corpus-limit=10000
 *
 *   # 既存結果を残して一部アームだけ測り直す
 *   pnpm embedding:evaluate -- --run --resume --arms=ruri310,ruri+sparse@a0.7
 *
 *   # 特定クエリだけ定性確認
 *   pnpm embedding:evaluate -- --run --resume --queries=walpurgis
 *
 *   # review.md を人手で採点したあと、その採点で再集計
 *   pnpm embedding:evaluate -- --judge=human
 *
 * 出力先は docs/evaluations/embedding/（--out で変更可）:
 *   result.json   全アームの top-20・生スコア・レイテンシ・採点キーの対応表
 *   review.md     ブラインド採点表（アーム名は伏せ、LLM の下書き点入り）
 *   summary.md    nDCG@10 / P@1 / P@5 / MRR / Recall@20 の集計
 *
 * コーパス本文は .cache/embedding-eval/ にだけ置く（gitignore 済み）。
 * 実ユーザーの投稿本文なので docs/ 配下にもリポジトリにも入れない。
 *
 * 【重要】LLM-as-judge はあくまで下書き。日本語の固有名詞は判定がぶれるので、
 * review.md を人手で確認してから --judge=human で再集計すること。
 *
 * 【本番DBへの書き込みは一切しない】このスクリプトは db.select しか使わない。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, desc, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  bot_memory_documents,
  db,
  client,
  nagiPosts,
} from "../packages/database/src/db.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};
const list = (name: string): string[] | null => {
  const raw = option(name);
  if (!raw) return null;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
};

const RUN = hasFlag("run");
/**
 * 本番のあいまい検索と同じく、本文にクエリ語をそのまま含む文書を候補から落とす。
 *
 * `semanticConditions`（apps/nagi_appview/src/queries/hybridSearch.ts）は一致セクションと
 * 排他にするため `textExpr not ilike '%q%'` を掛けている。既定のハーネスはコーパス全体で
 * ランキングするので、**その数字は hybrid モードと一致セクションを含めた総合力**であって、
 * あいまい検索セクション単体の実力ではない。両者は順位すら変わる（README「結果表の読み方」）。
 */
const EXCLUDE_LITERAL = hasFlag("exclude-literal");

/** 本番の ILIKE 判定と揃える（大文字小文字を無視した部分一致）。 */
function containsLiteral(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}
const RESUME = hasFlag("resume");
const WITH_GEMINI = hasFlag("with-gemini");
const JUDGE_MODE = (option("judge") ?? "llm") as "llm" | "human" | "none";
const CORPUS_LIMIT = Math.max(1, Number(option("corpus-limit") ?? 10_000));
const ARM_FILTER = list("arms");
const QUERY_FILTER = list("queries");
const RERANK_BASE = list("rerank-base");
/**
 * コーパスの出どころ。posts は Nagi 検索、memory は botMemory RAG。
 * 型は下の CorpusSource だが、OUT_DIR の既定を決めるためここで先に読む。
 */
const SOURCE = (option("source") ?? "posts") as "posts" | "memory";
// 出力先も source ごとに分ける。分けないと memory の実行が posts の result.json を
// 上書きして、せっかくの人手採点が消える。
const OUT_DIR = path.resolve(
  option("out") ??
    (SOURCE === "memory"
      ? "docs/evaluations/embedding-memory"
      : "docs/evaluations/embedding"),
);
const CACHE_DIR = path.resolve(option("cache") ?? ".cache/embedding-eval");
const SIDECAR_URL = (
  process.env.EMBED_EVAL_SIDECAR_URL ?? "http://127.0.0.1:7997"
).replace(/\/$/, "");
const JUDGE_MODEL =
  process.env.EMBED_EVAL_JUDGE_MODEL ??
  process.env.OLLAMA_MODEL ??
  "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S";

// ---------------------------------------------------------------------------
// 課金経路のゲート（evaluateLocalModels.mts と同じ方式）
//
// 既定では Gemini を1回も叩かない。--with-gemini のときだけ開き、開いたあとも
// fetch 層で回数を数えて上限で止める。import 時点では誰も撃たないので main より前に効く。
// ---------------------------------------------------------------------------
const GEMINI_CALL_CAP = Math.max(1, Number(option("gemini-cap") ?? 60));
const realFetch = globalThis.fetch;
let geminiCalls = 0;

globalThis.fetch = ((input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? input));
  if (/googleapis\.com|generativelanguage/i.test(url)) {
    if (!WITH_GEMINI) {
      throw new Error(`BLOCKED: --with-gemini なしで Gemini が呼ばれました (${url})`);
    }
    if (geminiCalls >= GEMINI_CALL_CAP) {
      throw new Error(`BUDGET: Gemini 呼び出し上限 ${GEMINI_CALL_CAP} 回に到達しました`);
    }
    geminiCalls += 1;
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// クエリセット
// ---------------------------------------------------------------------------

export type EvalQuery = {
  id: string;
  category: string;
  text: string;
  expect?: string;
};

/**
 * クエリセットの場所。`--queries-file=` で明示でき、無指定なら --source に追従する。
 * posts（Nagi 検索）と memory（botMemory RAG）では対象文書の性質がまるで違うので、
 * 同じクエリで測ると両方について誤った結論が出る。
 */
function queriesPath(): string {
  const explicit = option("queries-file");
  if (explicit) return path.resolve(explicit);
  return path.resolve(
    SOURCE === "memory"
      ? "scripts/fixtures/embeddingQueriesMemory.json"
      : "scripts/fixtures/embeddingQueries.json",
  );
}

async function loadQueries(): Promise<EvalQuery[]> {
  const file = queriesPath();
  const raw = await readFile(file).catch(() => {
    throw new Error(`クエリセットが見つかりません: ${file}`);
  });
  const all = (JSON.parse(raw.toString("utf8")).queries ?? []) as EvalQuery[];
  if (!all.length) throw new Error(`クエリが0件です: ${file}`);
  return QUERY_FILTER ? all.filter((q) => QUERY_FILTER.includes(q.id)) : all;
}

// ---------------------------------------------------------------------------
// エンコーダ（埋め込みモデル）
//
// 接頭辞・instruction は**モデルごとに公式の形へ揃える**。ここを揃えないと
// 「モデルが弱い」のか「使い方が違う」のか分からなくなる。
// ---------------------------------------------------------------------------

export type Encoder = {
  id: string;
  label: string;
  provider: "ollama" | "sidecar" | "gemini";
  model: string;
  /** 期待次元。実測がここと違えばモデル取り違えなので落とす。 */
  dim: number;
  /** 文書側に付ける接頭辞。 */
  docPrefix: string;
  /** クエリ側に付ける接頭辞（instruction を含む）。 */
  queryPrefix: string;
  /**
   * クエリを LLM で膨らませてから埋め込む（接頭辞より先に適用）。
   *  - "terms": 関連語を足す。「ワルプルギス」→「ワルプルギス まどか☆マギカ 魔法少女 …」
   *  - "hyde":  そのクエリに答える架空の投稿を1本書かせ、それを埋め込む
   * 文書側には一切影響しないので、文書埋め込みキャッシュは非拡張版と共有される。
   */
  expandQuery?: "terms" | "hyde" | "alias";
  note: string;
};

export const ENCODERS: Encoder[] = [
  {
    id: "arctic",
    label: "snowflake-arctic-embed2（2026-09-04 まで本番）",
    provider: "ollama",
    // **env を見ないこと。** かつて OLLAMA_EMBED_MODEL を既定にしていたが、
    // 本番を qwen3 へ差し替えた瞬間にベースラインまで qwen3 になり、
    // 「現行との比較」が成立しなくなった（実際 --source=memory のドライランで発覚）。
    // 過去との比較可能性を保つため、ここは常に固定のモデル名を指す。
    model: "snowflake-arctic-embed2",
    dim: 1024,
    docPrefix: "",
    // 当時の本番も接頭辞なし（OLLAMA_QUERY_PREFIX の既定が空文字だった）。
    queryPrefix: "",
    note: "旧ベースライン。過去の結果と地続きにするために残してある。",
  },
  {
    id: "arctic-q",
    label: "snowflake-arctic-embed2 + query: 接頭辞",
    provider: "ollama",
    model: "snowflake-arctic-embed2",
    dim: 1024,
    docPrefix: "",
    // arctic-embed v2.0 本来の設計。hybridSearch.ts のコメントは「効かない」と
    // 結論づけていたが、それはランキングではなくスコアの目視で判断したもので、
    // 2026-09-04 の実測で誤りと分かった（nDCG 0.366 → 0.548）。
    queryPrefix: "query: ",
    note: "接頭辞のみで現行からどこまで戻せるかの対照。",
  },
  {
    id: "bge-dense",
    label: "bge-m3 (dense)",
    provider: "ollama",
    model: "bge-m3",
    dim: 1024,
    docPrefix: "",
    queryPrefix: "",
    note: "多言語・8192トークン。sparse と組む相方。",
  },
  {
    id: "ruri310",
    label: "ruri-v3-310m",
    provider: "sidecar",
    model: "cl-nagoya/ruri-v3-310m",
    dim: 768,
    // ruri-v3 は接頭辞が必須。付けないと性能が出ない。
    docPrefix: "検索文書: ",
    queryPrefix: "検索クエリ: ",
    note: "記事の推し。日本語特化 ModernBERT-Ja。",
  },
  {
    id: "egemma",
    label: "embeddinggemma-300m",
    provider: "ollama",
    model: "embeddinggemma",
    dim: 768,
    // EmbeddingGemma の公式プロンプト形式。title が無い文書は "none"。
    docPrefix: "title: none | text: ",
    queryPrefix: "task: search result | query: ",
    note: "Ollama 公式ライブラリにあり、サイドカー不要で本番へ載せられる。",
  },
  {
    id: "qwen3-06b",
    label: "Qwen3-Embedding-0.6B",
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dim: 1024,
    // Qwen3-Embedding は文書側に接頭辞を付けず、クエリ側だけ instruction を付ける。
    docPrefix: "",
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: ",
    note: "2026-09-04 から本番。Ollama 公式ライブラリにあり、instruction-aware。",
  },
  {
    id: "qwen3-noprefix",
    label: "Qwen3-Embedding-0.6B（クエリ接頭辞なし）",
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dim: 1024,
    docPrefix: "",
    // botMemory RAG は「投稿 → 過去の関連記憶」という**対称的な**タスクで、
    // 「検索語 → 文書」ではない。instruction 接頭辞がこの用途でも効くのかは
    // 本番へ入れた時点では未検証だったので、ここで接頭辞なしと突き合わせる。
    // 文書側キャッシュのキーは provider:model:docPrefix なので qwen3-06b と共有され、
    // このアームを足しても文書の再埋め込みは発生しない。
    queryPrefix: "",
    note: "接頭辞の要否を切り分けるための対照。",
  },
  {
    id: "qwen3-expand-terms",
    label: "Qwen3-Embedding-0.6B + クエリ拡張（関連語）",
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dim: 1024,
    // **docPrefix は qwen3-06b と一字一句同じにすること。** 文書埋め込みキャッシュは
    // digest(provider:model:docPrefix) でキーされるので、ここがズレると
    // 3,000件を無駄に再埋め込みする。拡張はクエリ側だけの操作。
    docPrefix: "",
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: ",
    expandQuery: "terms",
    note: "26B の世界知識でクエリを膨らませ、語彙ギャップを埋められるかを見る。",
  },
  {
    id: "qwen3-expand-hyde",
    label: "Qwen3-Embedding-0.6B + クエリ拡張（架空投稿/HyDE）",
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dim: 1024,
    docPrefix: "",
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: ",
    expandQuery: "hyde",
    note: "クエリを架空の投稿へ変換してから埋め込む。文書と同じ分布に寄せる狙い。",
  },
  {
    id: "qwen3-expand-alias",
    label: "Qwen3-Embedding-0.6B + 別名拡張（固有名詞のみ）",
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dim: 1024,
    docPrefix: "",
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: ",
    // terms は全クエリを一律に膨らませて一般語を悪化させた（general 0.646 → 0.625）。
    // alias は LLM が別名を知っている固有名詞だけを拡張し、それ以外は素通しする。
    expandQuery: "alias",
    note: "略称（まどマギ・ブルアカ）で正式名称の投稿を引けるようにする狙い。",
  },
  {
    id: "e5-large",
    label: "multilingual-e5-large",
    provider: "sidecar",
    model: "intfloat/multilingual-e5-large",
    dim: 1024,
    docPrefix: "passage: ",
    queryPrefix: "query: ",
    note: "arctic-embed2 の系譜にあたる定番対照。",
  },
  {
    id: "gemini",
    label: "Gemini embedding-001（課金・参考値）",
    provider: "gemini",
    model: "gemini-embedding-001",
    dim: 3072,
    docPrefix: "",
    queryPrefix: "",
    note: "記事の1位。--with-gemini のときだけ動く参考値。",
  },
];

const encoderById = new Map(ENCODERS.map((e) => [e.id, e]));

// ---------------------------------------------------------------------------
// アーム（検索構成）
//
// コーパスの埋め込みは1モデル1回で済むので、アームはスコアリングの組み合わせで増やす。
// ---------------------------------------------------------------------------

export type Arm = {
  id: string;
  label: string;
  tier: 1 | 2 | 3;
  /** dense 信号に使うエンコーダ id。 */
  dense?: string;
  /** bge-m3 sparse を混ぜるか。 */
  sparse?: boolean;
  /** pg_trgm の similarity() を混ぜるか。 */
  lexical?: boolean;
  /**
   * 融合方式。
   *  - "minmax": 候補集合内で min-max 正規化してから加重和（記事の weighted_fusion）
   *  - "raw":    正規化せず生スコアに重みを掛ける（**本番 hybridConditions の再現**）
   */
  fusion: "minmax" | "raw";
  weights: { dense?: number; sparse?: number; lexical?: number };
  /** cross-encoder で上位を並べ替える場合のサイドカーモデル。 */
  rerank?: string;
  /** rerank アームの土台になるアーム id。 */
  base?: string;
  note?: string;
};

/** weighted fusion の α スイープ。dense:α / sparse:(1-α)。 */
const ALPHAS = [0.3, 0.5, 0.7, 0.9];

function buildArms(): Arm[] {
  const arms: Arm[] = [
    {
      id: "arctic",
      label: "arctic dense のみ",
      tier: 1,
      dense: "arctic",
      fusion: "raw",
      weights: { dense: 1 },
      note: "現行のあいまい検索（semanticConditions）に相当。",
    },
    {
      id: "arctic-q",
      label: "arctic dense のみ + query: 接頭辞",
      tier: 1,
      dense: "arctic-q",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "arctic+trgm",
      label: "arctic dense 0.7 + pg_trgm 0.3（現行本番の再現）",
      tier: 1,
      dense: "arctic",
      lexical: true,
      fusion: "raw",
      // hybridSearch.ts の SEM_WEIGHT / LEX_WEIGHT をそのまま持ってくる。
      weights: { dense: 0.7, lexical: 0.3 },
      note: "**真のベースライン**。候補はこれに勝たなければ置き換える意味がない。",
    },
    {
      id: "qwen3-noprefix",
      label: "qwen3 dense のみ（クエリ接頭辞なし）",
      tier: 1,
      dense: "qwen3-noprefix",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "ruri310",
      label: "ruri-v3-310m dense のみ",
      tier: 1,
      dense: "ruri310",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "bge-dense",
      label: "bge-m3 dense のみ",
      tier: 1,
      dense: "bge-dense",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "bge-sparse",
      label: "bge-m3 sparse のみ",
      tier: 1,
      sparse: true,
      fusion: "raw",
      weights: { sparse: 1 },
      note: "固有名詞が dense でなく sparse で拾えているかの単独確認。",
    },
    {
      id: "egemma",
      label: "embeddinggemma dense のみ",
      tier: 2,
      dense: "egemma",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "qwen3-06b",
      label: "Qwen3-Embedding-0.6B dense のみ",
      tier: 2,
      dense: "qwen3-06b",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "qwen3-expand-terms",
      label: "qwen3 + クエリ拡張（関連語）",
      tier: 2,
      dense: "qwen3-expand-terms",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "qwen3-expand-hyde",
      label: "qwen3 + クエリ拡張（架空投稿/HyDE）",
      tier: 2,
      dense: "qwen3-expand-hyde",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "qwen3-expand-alias",
      label: "qwen3 + 別名拡張（固有名詞のみ）",
      tier: 2,
      dense: "qwen3-expand-alias",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "e5-large",
      label: "multilingual-e5-large dense のみ",
      tier: 2,
      dense: "e5-large",
      fusion: "raw",
      weights: { dense: 1 },
    },
    {
      id: "gemini",
      label: "Gemini embedding-001 dense のみ（参考）",
      tier: 2,
      dense: "gemini",
      fusion: "raw",
      weights: { dense: 1 },
    },
  ];

  // 記事の推し構成と、その比較対象。α をスイープして最適点も併せて見る。
  for (const [id, dense] of [
    ["ruri+sparse", "ruri310"],
    ["bge+sparse", "bge-dense"],
    ["egemma+sparse", "egemma"],
  ] as const) {
    for (const alpha of ALPHAS) {
      arms.push({
        id: `${id}@a${alpha}`,
        label: `${dense} dense ${alpha} + bge-m3 sparse ${(1 - alpha).toFixed(1)}`,
        tier: id === "egemma+sparse" ? 2 : 1,
        dense,
        sparse: true,
        fusion: "minmax",
        weights: { dense: alpha, sparse: 1 - alpha },
      });
    }
  }

  // リランカーは上位アームにだけ足して増分を見る。土台は --rerank-base= で差し替える。
  const bases = RERANK_BASE ?? ["arctic+trgm", "ruri+sparse@a0.7"];
  for (const base of bases) {
    for (const [suffix, model] of [
      ["rerank-ruri", "cl-nagoya/ruri-v3-reranker-310m"],
      ["rerank-bge", "BAAI/bge-reranker-v2-m3"],
    ] as const) {
      arms.push({
        id: `${base}+${suffix}`,
        label: `${base} の上位50件を ${model} で並べ替え`,
        tier: 3,
        base,
        rerank: model,
        fusion: "raw",
        weights: {},
      });
    }
  }

  return arms;
}

/** rerank アームが土台にするアームも必ず計算対象へ入れる。 */
function withBases(arms: Arm[], all: Arm[]): Arm[] {
  const byId = new Map(all.map((a) => [a.id, a]));
  const out = new Map(arms.map((a) => [a.id, a]));
  for (const arm of arms) {
    if (arm.base && !out.has(arm.base)) {
      const base = byId.get(arm.base);
      if (base) out.set(base.id, base);
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// プロバイダ（埋め込みの取得経路）
// ---------------------------------------------------------------------------

/** Ollama へのバッチ入力サイズ。大きすぎると1リクエストが詰まる。 */
const EMBED_BATCH = 32;
const SIDECAR_BATCH = 32;
const GEMINI_BATCH = 100;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** L2 正規化。cosine を内積1本で済ませるため、取り込み時に必ず通す。 */
function normalize(vec: number[]): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function ollamaEmbedBatch(model: string, texts: string[]): Promise<number[][]> {
  const baseUrl = process.env.OLLAMA_EMBED_BASE_URL ?? process.env.OLLAMA_BASE_URL;
  if (!baseUrl) throw new Error("OLLAMA_BASE_URL（または OLLAMA_EMBED_BASE_URL）が未設定");
  // OpenAI 互換 /v1/embeddings。options を持たないので num_ctx 混入の余地がない
  // （AGENTS.md「Ollama の num_ctx」）。
  const response = await realFetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama embeddings HTTP ${response.status} (${model}): ${await response.text()}`);
  }
  const data = (await response.json()) as any;
  if (!Array.isArray(data?.data) || data.data.length !== texts.length) {
    throw new Error(`Ollama embeddings の件数が不一致 (${model})`);
  }
  return data.data.map((d: any) => d.embedding as number[]);
}

async function sidecarDenseBatch(model: string, texts: string[]): Promise<number[][]> {
  const response = await realFetch(`${SIDECAR_URL}/dense`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, texts }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(`sidecar /dense HTTP ${response.status} (${model}): ${await response.text()}`);
  }
  return ((await response.json()) as any).embeddings as number[][];
}

async function geminiEmbedBatch(model: string, texts: string[]): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY が未設定");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Gemini embed HTTP ${response.status}: ${await response.text()}`);
  }
  return ((await response.json()) as any).embeddings.map((e: any) => e.values as number[]);
}

async function encode(encoder: Encoder, texts: string[]): Promise<Float32Array[]> {
  const size =
    encoder.provider === "ollama"
      ? EMBED_BATCH
      : encoder.provider === "sidecar"
        ? SIDECAR_BATCH
        : GEMINI_BATCH;
  const out: Float32Array[] = [];
  const batches = chunk(texts, size);
  for (let i = 0; i < batches.length; i++) {
    const raw =
      encoder.provider === "ollama"
        ? await ollamaEmbedBatch(encoder.model, batches[i])
        : encoder.provider === "sidecar"
          ? await sidecarDenseBatch(encoder.model, batches[i])
          : await geminiEmbedBatch(encoder.model, batches[i]);
    for (const vec of raw) {
      // 取り違え検知。次元が違えば別モデルを引いている。
      if (vec.length !== encoder.dim) {
        throw new Error(
          `${encoder.id}: 次元が想定外 expected=${encoder.dim} actual=${vec.length}`,
        );
      }
      out.push(normalize(vec));
    }
    if (batches.length > 4 && i % 20 === 0) {
      process.stderr.write(`  ${encoder.id}: ${out.length}/${texts.length}\n`);
    }
  }
  return out;
}

/** bge-m3 の sparse（lexical weights）。Ollama では取れないのでサイドカー必須。 */
type SparseVec = Map<string, number>;

async function sparseEncode(texts: string[]): Promise<SparseVec[]> {
  const out: SparseVec[] = [];
  const batches = chunk(texts, 16);
  for (let i = 0; i < batches.length; i++) {
    const response = await realFetch(`${SIDECAR_URL}/sparse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: batches[i] }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      throw new Error(`sidecar /sparse HTTP ${response.status}: ${await response.text()}`);
    }
    for (const row of ((await response.json()) as any).weights as Record<string, number>[]) {
      out.push(new Map(Object.entries(row)));
    }
    if (batches.length > 4 && i % 20 === 0) {
      process.stderr.write(`  sparse: ${out.length}/${texts.length}\n`);
    }
  }
  return out;
}

async function sidecarRerank(
  model: string,
  query: string,
  texts: string[],
): Promise<number[]> {
  const response = await realFetch(`${SIDECAR_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, query, texts }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(`sidecar /rerank HTTP ${response.status} (${model}): ${await response.text()}`);
  }
  return ((await response.json()) as any).scores as number[];
}

async function sidecarAvailable(): Promise<boolean> {
  try {
    const response = await realFetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// コーパス（本番DBから read-only）
// ---------------------------------------------------------------------------

export type CorpusSource = "posts" | "memory";
export type CorpusDoc = { id: string; text: string };

async function loadCorpus(source: CorpusSource): Promise<CorpusDoc[]> {
  if (source === "posts") {
    // 非公開（kossori）と CH 限定は評価コーパスに入れない。本番の検索でも
    // グローバルには出ないうえ、本文をローカルへ落とす対象にすべきでない。
    const rows = await db
      .select({ id: nagiPosts.uri, text: nagiPosts.text })
      .from(nagiPosts)
      .where(
        and(
          isNull(nagiPosts.deletedAt),
          ne(nagiPosts.text, ""),
          ne(nagiPosts.kossori, true),
        ),
      )
      .orderBy(desc(nagiPosts.indexedAt))
      .limit(CORPUS_LIMIT);
    return rows;
  }
  const rows = await db
    .select({ id: bot_memory_documents.id, text: bot_memory_documents.content })
    .from(bot_memory_documents)
    .where(and(isNull(bot_memory_documents.deleted_at), ne(bot_memory_documents.content, "")))
    .orderBy(desc(bot_memory_documents.occurred_at))
    .limit(CORPUS_LIMIT);
  return rows.map((r) => ({ id: String(r.id), text: r.text }));
}

/**
 * pg_trgm の similarity()。本番 hybridConditions の語彙側そのものなので、
 * TS で再実装せず **pg に計算させる**（read-only SELECT）。
 * 返さなかった行はスコア 0（similarity が 0）。
 */
async function lexicalScores(
  source: CorpusSource,
  ids: string[],
  query: string,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  // パラメータ上限（65535）に当てないよう分割する。
  for (const part of chunk(ids, 5_000)) {
    if (source === "posts") {
      const rows = await db
        .select({
          id: nagiPosts.uri,
          sim: sql<number>`similarity(${nagiPosts.text}, ${query})`,
        })
        .from(nagiPosts)
        .where(
          and(inArray(nagiPosts.uri, part), sql`similarity(${nagiPosts.text}, ${query}) > 0`),
        );
      for (const row of rows) scores.set(row.id, Number(row.sim));
    } else {
      const rows = await db
        .select({
          id: bot_memory_documents.id,
          sim: sql<number>`similarity(${bot_memory_documents.content}, ${query})`,
        })
        .from(bot_memory_documents)
        .where(
          and(
            inArray(bot_memory_documents.id, part.map(Number)),
            sql`similarity(${bot_memory_documents.content}, ${query}) > 0`,
          ),
        );
      for (const row of rows) scores.set(String(row.id), Number(row.sim));
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// キャッシュ
//
// 埋め込みはコーパス本文とモデルが決まれば一意なので、内容ハッシュで引く。
// --refresh で捨てる。**投稿本文を含むので .cache/ の外へは出さない。**
// ---------------------------------------------------------------------------

const REFRESH = hasFlag("refresh");

const cachePath = (name: string) => path.join(CACHE_DIR, name);

async function readJsonCache<T>(name: string): Promise<T | null> {
  if (REFRESH) return null;
  try {
    return JSON.parse(await readFile(cachePath(name), "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonCache(name: string, value: unknown): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(name), JSON.stringify(value), "utf8");
}

/** Float32 の行列はバイナリで置く。JSON にすると 10000×1024 で 200MB を超える。 */
async function readVectorCache(name: string, dim: number): Promise<Float32Array[] | null> {
  if (REFRESH) return null;
  try {
    const buf = await readFile(cachePath(name));
    const flat = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    if (flat.length % dim !== 0) return null;
    const out: Float32Array[] = [];
    for (let i = 0; i < flat.length; i += dim) out.push(flat.subarray(i, i + dim));
    return out;
  } catch {
    return null;
  }
}

async function writeVectorCache(name: string, vectors: Float32Array[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const dim = vectors[0]?.length ?? 0;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => flat.set(v, i * dim));
  await writeFile(cachePath(name), Buffer.from(flat.buffer));
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------
// スコアリング
// ---------------------------------------------------------------------------

/** 各信号から拾う候補数。融合はこの和集合の上でだけ行う。 */
const CANDIDATE_DEPTH = 200;
/** アームが内部で保持する順位の深さ（リランカーの入力にもなる）。 */
const RANK_DEPTH = 50;
/** result.json / review.md に載せる深さ。 */
const REPORT_DEPTH = 20;
/** プールに入れる深さ（＝採点対象）。 */
const POOL_DEPTH = 10;

type SignalName = "dense" | "sparse" | "lexical";

/** 疎ベクトルの転置索引。トークン → [文書index, 重み]。 */
function buildSparseIndex(docs: SparseVec[]): Map<string, Array<[number, number]>> {
  const index = new Map<string, Array<[number, number]>>();
  docs.forEach((vec, i) => {
    for (const [token, weight] of vec) {
      let posting = index.get(token);
      if (!posting) index.set(token, (posting = []));
      posting.push([i, weight]);
    }
  });
  return index;
}

/** bge-m3 の compute_lexical_matching_score と同じ: 共有トークンの重み積の総和。 */
function sparseScores(
  index: Map<string, Array<[number, number]>>,
  query: SparseVec,
  size: number,
): Float32Array {
  const scores = new Float32Array(size);
  for (const [token, qw] of query) {
    const posting = index.get(token);
    if (!posting) continue;
    for (const [docIndex, dw] of posting) scores[docIndex] += qw * dw;
  }
  return scores;
}

function denseScores(docs: Float32Array[], query: Float32Array): Float32Array {
  const scores = new Float32Array(docs.length);
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    let dot = 0;
    for (let j = 0; j < doc.length; j++) dot += doc[j] * query[j];
    scores[i] = dot;
  }
  return scores;
}

function topIndices(scores: Float32Array, depth: number): number[] {
  const indices = Array.from(scores.keys());
  indices.sort((a, b) => scores[b] - scores[a]);
  return indices.slice(0, depth);
}

function minMax(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return span > 0 ? values.map((v) => (v - min) / span) : values.map(() => 0);
}

export type ArmHit = {
  id: string;
  score: number;
  signals: Partial<Record<SignalName, number>>;
};

/**
 * 1アーム × 1クエリの順位。
 * 候補は各信号の上位 CANDIDATE_DEPTH の和集合。全件を融合しないのは計算量のためで、
 * 最終的な上位10件はいずれかの信号で上位に入っているはずなので実害はない。
 */
function rankArm(
  arm: Arm,
  corpus: CorpusDoc[],
  signals: Partial<Record<SignalName, Float32Array>>,
  /** --exclude-literal のとき、この語を本文に含む文書を候補から落とす。 */
  literalQuery?: string,
): ArmHit[] {
  const active = (Object.keys(signals) as SignalName[]).filter(
    (name) => signals[name] !== undefined,
  );
  if (!active.length) return [];

  const candidates = new Set<number>();
  for (const name of active) {
    for (const index of topIndices(signals[name]!, CANDIDATE_DEPTH)) candidates.add(index);
  }
  let indices = [...candidates];
  if (literalQuery) {
    indices = indices.filter((i) => !containsLiteral(corpus[i].text, literalQuery));
  }

  const perSignal: Partial<Record<SignalName, number[]>> = {};
  for (const name of active) {
    const raw = indices.map((i) => signals[name]![i]);
    perSignal[name] = arm.fusion === "minmax" ? minMax(raw) : raw;
  }

  const hits: ArmHit[] = indices.map((docIndex, slot) => {
    let score = 0;
    const detail: Partial<Record<SignalName, number>> = {};
    for (const name of active) {
      const weight = arm.weights[name] ?? 0;
      score += weight * perSignal[name]![slot];
      detail[name] = signals[name]![docIndex];
    }
    return { id: corpus[docIndex].id, score, signals: detail };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, RANK_DEPTH);
}

// ---------------------------------------------------------------------------
// LLM-as-judge（下書き採点）
// ---------------------------------------------------------------------------

/**
 * Ollama ネイティブ /api/chat のリクエスト本体。
 *
 * **options に num_ctx を入れない。** サーバの OLLAMA_CONTEXT_LENGTH が唯一の源で、
 * 違う値を送ると同じモデルでも runner が作り直され、同居アプリごと巻き込む
 * （AGENTS.md「Ollama の num_ctx」）。num_predict は必ず送る。
 * テストから検証するため export している。
 */
export function buildJudgeRequestBody(model: string, prompt: string, maxTokens: number) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    // reasoning に生成枠を食わせない。切らないと scores が空のまま返る。
    think: false,
    format: {
      type: "object",
      properties: {
        scores: { type: "array", items: { type: "integer" } },
      },
      required: ["scores"],
    },
    options: {
      temperature: 0,
      num_predict: maxTokens,
    },
  };
}

function judgePrompt(query: EvalQuery, texts: string[]): string {
  const docs = texts
    .map((text, i) => `${i + 1}. ${text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    "あなたは検索評価の採点者です。以下の検索クエリに対し、各投稿がどれだけ関連するかを採点してください。",
    "",
    `検索クエリ: ${query.text}`,
    query.expect ? `想定される関連内容: ${query.expect}` : "",
    "",
    "採点基準:",
    "  2 = 明確に関連する（クエリの話題そのもの、または直接的な言及）",
    "  1 = やや関連する（同じジャンル・周辺の話題）",
    "  0 = 無関係",
    "",
    "投稿:",
    docs,
    "",
    `${texts.length} 件すべてについて、入力と同じ順で scores 配列に 0/1/2 を入れて返してください。`,
  ]
    .filter(Boolean)
    .join("\n");
}

const JUDGE_BATCH = 8;

// ---------------------------------------------------------------------------
// クエリ拡張（doc2query の逆。文書ではなくクエリ側を膨らませる）
//
// 埋め込みモデルが 0.6B だと「ワルプルギス＝まどマギ」のような世界知識を持たず、
// 語を含まない関連投稿へ届かない（実測で walpurgis は全モデル nDCG@10 = 0.000）。
// そこを 26B の知識で埋められるかを測るためのもの。
// 文書側を 3,515件タグ付けする案（約17時間）と違い、検索時に1生成で済む。
// ---------------------------------------------------------------------------

/**
 * 拡張リクエストの本体。
 *
 * **options に num_ctx を入れない。** サーバの OLLAMA_CONTEXT_LENGTH が唯一の源で、
 * 違う値を送ると同じモデルでも runner が作り直され、同居アプリごと巻き込む
 * （AGENTS.md「Ollama の num_ctx」）。num_predict は必ず送る。
 * テストから検証するため export している。
 */
export function buildExpansionRequestBody(
  model: string,
  prompt: string,
  maxTokens: number,
  /** alias モードは文字列ではなく配列を返させる。 */
  shape: "expanded" | "aliases" = "expanded",
) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    // reasoning に生成枠を食わせない。切らないと expanded が空のまま返る。
    think: false,
    format:
      shape === "aliases"
        ? {
            type: "object",
            properties: { aliases: { type: "array", items: { type: "string" } } },
            required: ["aliases"],
          }
        : {
            type: "object",
            properties: { expanded: { type: "string" } },
            required: ["expanded"],
          },
    options: {
      temperature: 0,
      num_predict: maxTokens,
    },
  };
}

function expansionPrompt(mode: "terms" | "hyde" | "alias", query: string): string {
  if (mode === "alias") {
    // terms との違いは「**別名を知っているときだけ**返す」こと。
    // terms は全クエリを一律に膨らませるので、一般語（散歩→ウォーキング 散策 運動…）まで
    // 拡張して曖昧にし、実測で general が 0.646 → 0.625 に落ちた。
    // ここで空配列を返せば呼び出し側が元のクエリをそのまま使うので、悪化しようがない。
    return [
      "あなたは日本語の検索を補助するアシスタントです。",
      "与えられた検索語が**作品名・製品名・団体名などの固有名詞**で、かつ",
      "別の呼ばれ方（正式名称・略称・原語表記）があるなら、それらを挙げてください。",
      "",
      "規則:",
      "  - 固有名詞でない普通の言葉（散歩・仕事・猫など）は**必ず空配列**",
      "  - 別名を知らない固有名詞も**空配列**。推測で書かない",
      // **別名は「コーパスの言語」で出す。** 検索対象が日本語の投稿なので日本語で返させる。
      // クエリの言語で決めるのではない点が肝で、これが両方向を同時に満たす:
      //   日本語クエリ: まどマギ → 魔法少女まどか☆マギカ  (madomagi 0.641 → 1.000)
      //   英語クエリ:   kantai collection → 艦隊これくしょん (該当ヒット 0/10 → 10/10)
      // 逆に日本語クエリへ英語別名を足すと悪化する（zelda に The Legend of Zelda を
      // 足した版は 0.287 → 0.225）。日本語コーパスからベクトルが離れるため。
      "  - 別名がある場合のみ、**日本語表記のみ**で正式名称・別称を3個まで",
      "  - 英語・ローマ字の表記は入れない（検索対象が日本語の投稿のため。",
      "    検索語自体が英語やローマ字でも、返す別名は日本語にすること）",
      "  - 元の検索語の単なる言い換えや部分一致は入れない（例: ウマ娘 → ウマ娘 プリティーダービー は不可）",
      "  - 元の検索語は含めなくてよい（呼び出し側で足す）",
      "",
      "例:",
      "  入力: エヴァ        → [\"エヴァンゲリオン\", \"新世紀エヴァンゲリオン\"]",
      "  入力: 散歩          → []",
      "  入力: ポケモン      → [\"ポケットモンスター\"]",
      "  入力: 落ち込んだ話  → []",
      "",
      `検索語: ${query}`,
      "",
      "aliases に配列で入れて返してください。別名が無ければ空配列。",
    ].join("\n");
  }
  if (mode === "terms") {
    return [
      "あなたは日本語の検索を補助するアシスタントです。",
      "与えられた検索語について、同じ話題を指す別名・正式名称・関連する固有名詞・",
      "上位カテゴリを挙げ、元の語と合わせて半角スペース区切りの1行にしてください。",
      "",
      "規則:",
      "  - 元の検索語を必ず先頭に含める",
      "  - 5〜10語程度。説明文や記号は書かない",
      "  - 知らない語なら元の語だけを返す。**推測で無関係な語を足さない**",
      "",
      // **例に評価クエリを使わないこと。** 最初 "ワルプルギス" を例にしたところ、
      // モデルが例文をそのまま返し、判断基準にしている当のクエリの答えを
      // こちらが教えてしまっていた（生成結果が例文と一字一句一致）。
      // ここは embeddingQueries.json / embeddingQueriesMemory.json のどちらにも
      // 出てこない語を使う。
      "例:",
      "  入力: エヴァ",
      "  出力: エヴァ エヴァンゲリオン 新世紀エヴァンゲリオン 庵野秀明 アニメ ロボット 使徒",
      "",
      `検索語: ${query}`,
      "",
      "expanded に1行で入れて返してください。",
    ].join("\n");
  }
  return [
    "あなたは日本語のSNS利用者です。",
    "与えられた検索語について、その話題を語っている架空の投稿を1つ書いてください。",
    "",
    "規則:",
    "  - 100文字程度の自然な口語。ハッシュタグやURLは書かない",
    "  - その話題を知らなければ、検索語をそのまま含む当たり障りのない投稿にする",
    "  - **知ったかぶりで別の話題にすり替えない**",
    "",
    `検索語: ${query}`,
    "",
    "expanded に投稿本文だけを入れて返してください。",
  ].join("\n");
}

/**
 * クエリを LLM で拡張する。結果はディスクにキャッシュする。
 * 拡張は**エンコーダに依存しない**ので、qwen3 と egemma の拡張アームを両方測っても
 * 生成は1回で済む（キャッシュキーに埋め込みモデルを含めない理由）。
 */
async function expandQueries(
  mode: "terms" | "hyde" | "alias",
  queries: EvalQuery[],
): Promise<Map<string, string>> {
  const cacheName = `expand-${mode}-${digest(JUDGE_MODEL)}.json`;
  const cached = (await readJsonCache<Record<string, string>>(cacheName)) ?? {};
  const out = new Map<string, string>();
  let dirty = false;

  const baseUrl = process.env.OLLAMA_BASE_URL;
  const nativeUrl = baseUrl?.replace(/\/v1\/?$/, "").replace(/\/$/, "");

  for (const query of queries) {
    const hit = cached[query.text];
    if (hit) {
      out.set(query.id, hit);
      continue;
    }
    if (!nativeUrl) throw new Error("OLLAMA_BASE_URL が未設定（クエリ拡張に必要）");
    const response = await realFetch(`${nativeUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildExpansionRequestBody(
          JUDGE_MODEL,
          expansionPrompt(mode, query.text),
          256,
          mode === "alias" ? "aliases" : "expanded",
        ),
      ),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      throw new Error(`expand HTTP ${response.status}: ${await response.text()}`);
    }
    const content = ((await response.json()) as any)?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }

    let text: string;
    if (mode === "alias") {
      // **空配列なら元のクエリをそのまま使う。** これが terms との決定的な違いで、
      // 「別名を知らない語は触らない」から一般語を悪化させようがない。
      const aliases = (parsed as any)?.aliases;
      const list = Array.isArray(aliases)
        ? aliases.map(String).map((a) => a.trim()).filter(Boolean).slice(0, 3)
        : [];
      text = list.length ? `${query.text} ${list.join(" ")}` : query.text;
    } else {
      // 生成に失敗したら元のクエリへフォールバックする。ここで空文字を通すと
      // 「拡張が効かない」ではなく「クエリが消えた」結果を測ってしまう。
      const expanded = (parsed as any)?.expanded;
      text =
        typeof expanded === "string" && expanded.trim() ? expanded.trim() : query.text;
    }
    cached[query.text] = text;
    out.set(query.id, text);
    dirty = true;
    console.log(`  拡張[${mode}] ${query.id}: ${text.replace(/\s+/g, " ").slice(0, 70)}`);
  }

  if (dirty) await writeJsonCache(cacheName, cached);
  return out;
}

async function llmJudge(query: EvalQuery, docs: CorpusDoc[]): Promise<Map<string, number>> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!baseUrl) throw new Error("OLLAMA_BASE_URL が未設定（LLM 採点に必要）");
  // ネイティブ /api/chat を使う。OpenAI 互換だと think を切れない。
  const nativeUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const result = new Map<string, number>();

  for (const batch of chunk(docs, JUDGE_BATCH)) {
    const prompt = judgePrompt(query, batch.map((d) => d.text));
    const response = await realFetch(`${nativeUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildJudgeRequestBody(JUDGE_MODEL, prompt, 256)),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      throw new Error(`judge HTTP ${response.status}: ${await response.text()}`);
    }
    const content = ((await response.json()) as any)?.message?.content ?? "";
    let scores: unknown;
    try {
      scores = JSON.parse(content)?.scores;
    } catch {
      scores = null;
    }
    batch.forEach((doc, i) => {
      const value = Array.isArray(scores) ? Number(scores[i]) : NaN;
      // 採れなかったものは 0 ではなく「未判定」にしたいが、指標計算では 0 と同義に
      // なるので、ここでは 0 を入れつつ review.md で人手確認させる。
      result.set(doc.id, Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 0);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 指標
// ---------------------------------------------------------------------------

const gain = (rel: number) => 2 ** rel - 1;

function ndcgAt(ranked: string[], rel: Map<string, number>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    dcg += gain(rel.get(id) ?? 0) / Math.log2(i + 2);
  });
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((r, i) => {
    idcg += gain(r) / Math.log2(i + 2);
  });
  return idcg > 0 ? dcg / idcg : 0;
}

function precisionAt(ranked: string[], rel: Map<string, number>, k: number): number {
  const hits = ranked.slice(0, k).filter((id) => (rel.get(id) ?? 0) > 0).length;
  return k > 0 ? hits / k : 0;
}

function reciprocalRank(ranked: string[], rel: Map<string, number>): number {
  const at = ranked.findIndex((id) => (rel.get(id) ?? 0) > 0);
  return at === -1 ? 0 : 1 / (at + 1);
}

function recallAt(ranked: string[], rel: Map<string, number>, k: number): number {
  const relevant = [...rel.values()].filter((r) => r > 0).length;
  if (!relevant) return 0;
  const hits = ranked.slice(0, k).filter((id) => (rel.get(id) ?? 0) > 0).length;
  return hits / relevant;
}

// ---------------------------------------------------------------------------
// レポート
// ---------------------------------------------------------------------------

type PoolEntry = { key: string; docId: string; text: string };
type Judgments = Record<string, Record<string, number>>;

export type EvaluationResult = {
  generatedAt: string;
  source: CorpusSource;
  corpusSize: number;
  corpusHash: string;
  judgeModel: string;
  arms: Array<Pick<Arm, "id" | "label" | "tier" | "note"> & { deps: string }>;
  queries: EvalQuery[];
  rankings: Record<string, Record<string, ArmHit[]>>;
  pool: Record<string, PoolEntry[]>;
  judgments: { llm: Judgments; human?: Judgments };
  encoderLatencyMs: Record<string, number>;
};

/** 採点表の並びからアームを推測されないよう、クエリ id で決まる固定シャッフルをかける。 */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let state = Number.parseInt(digest(seed).slice(0, 8), 16) || 1;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const cell = (text: string) =>
  text.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);

function renderReview(result: EvaluationResult): string {
  const lines: string[] = [
    "# 埋め込みモデル評価 — ブラインド採点表",
    "",
    `- 生成: ${result.generatedAt}`,
    `- コーパス: ${result.source} / ${result.corpusSize} 件 (hash ${result.corpusHash})`,
    `- LLM 下書き採点: ${result.judgeModel}`,
    "",
    "## 採点のしかた",
    "",
    "各行の **判定** 列を書き換えてください（LLM 列は下書きなので触らなくてよい）。",
    "",
    "- `2` … 明確に関連する（クエリの話題そのもの、直接的な言及）",
    "- `1` … やや関連する（同じジャンル・周辺の話題）",
    "- `0` … 無関係",
    "",
    "どのアームが出した候補かは分からないよう並びをシャッフルしてあります。",
    "書き換えたら `pnpm embedding:evaluate -- --judge=human` で再集計してください。",
    "",
  ];

  for (const query of result.queries) {
    const entries = result.pool[query.id] ?? [];
    lines.push(`## ${query.id} — 「${query.text}」 (${query.category})`);
    if (query.expect) lines.push("", `想定: ${query.expect}`);
    lines.push("", "| key | 判定 | LLM | 本文 |", "| --- | --- | --- | --- |");
    for (const entry of entries) {
      const llm = result.judgments.llm[query.id]?.[entry.docId] ?? 0;
      const human = result.judgments.human?.[query.id]?.[entry.docId] ?? llm;
      lines.push(`| ${entry.key} | ${human} | ${llm} | ${cell(entry.text)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** review.md の 判定 列を読み戻す。key → docId の対応は result.json 側が持つ。 */
export function parseReview(markdown: string, result: EvaluationResult): Judgments {
  const byKey = new Map<string, { queryId: string; docId: string }>();
  for (const [queryId, entries] of Object.entries(result.pool)) {
    for (const entry of entries) byKey.set(entry.key, { queryId, docId: entry.docId });
  }
  const judgments: Judgments = {};
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*(q\d+-d\d+)\s*\|\s*([0-2])\s*\|/.exec(line.trim());
    if (!match) continue;
    const target = byKey.get(match[1]);
    if (!target) continue;
    (judgments[target.queryId] ??= {})[target.docId] = Number(match[2]);
  }
  return judgments;
}

function activeJudgments(result: EvaluationResult): Judgments {
  if (JUDGE_MODE !== "human") return result.judgments.llm;
  const human = result.judgments.human ?? {};
  // 人手が触っていないクエリは LLM の下書きで埋める（部分採点でも集計できるように）。
  const merged: Judgments = {};
  for (const query of result.queries) {
    merged[query.id] = { ...(result.judgments.llm[query.id] ?? {}), ...(human[query.id] ?? {}) };
  }
  return merged;
}

function renderSummary(result: EvaluationResult): string {
  const judgments = activeJudgments(result);
  const categories = [...new Set(result.queries.map((q) => q.category))];

  type Row = {
    arm: string;
    label: string;
    tier: number;
    deps: string;
    ndcg10: number;
    p1: number;
    p5: number;
    mrr: number;
    recall20: number;
    perCategory: Record<string, number>;
  };

  const rows: Row[] = result.arms.map((arm) => {
    const perQuery = result.queries.map((query) => {
      const ranked = (result.rankings[arm.id]?.[query.id] ?? []).map((h) => h.id);
      const rel = new Map(Object.entries(judgments[query.id] ?? {}));
      return {
        category: query.category,
        ndcg10: ndcgAt(ranked, rel, 10),
        p1: precisionAt(ranked, rel, 1),
        p5: precisionAt(ranked, rel, 5),
        mrr: reciprocalRank(ranked, rel),
        recall20: recallAt(ranked, rel, 20),
      };
    });
    const mean = (pick: (x: (typeof perQuery)[number]) => number, subset = perQuery) =>
      subset.length ? subset.reduce((sum, x) => sum + pick(x), 0) / subset.length : 0;
    return {
      arm: arm.id,
      label: arm.label,
      tier: arm.tier,
      deps: arm.deps,
      ndcg10: mean((x) => x.ndcg10),
      p1: mean((x) => x.p1),
      p5: mean((x) => x.p5),
      mrr: mean((x) => x.mrr),
      recall20: mean((x) => x.recall20),
      perCategory: Object.fromEntries(
        categories.map((c) => [
          c,
          mean((x) => x.ndcg10, perQuery.filter((x) => x.category === c)),
        ]),
      ),
    };
  });

  rows.sort((a, b) => b.ndcg10 - a.ndcg10);
  const fmt = (v: number) => v.toFixed(3);
  const baseline = rows.find((r) => r.arm === "arctic+trgm");

  const lines: string[] = [
    "# 埋め込みモデル評価 — 集計",
    "",
    `- 生成: ${result.generatedAt}`,
    `- コーパス: ${result.source} / ${result.corpusSize} 件 (hash ${result.corpusHash})`,
    `- 採点: ${JUDGE_MODE === "human" ? "人手（review.md）" : `LLM 下書きのみ（${result.judgeModel}）`}`,
    `- クエリ: ${result.queries.length} 件`,
    `- 対象: ${
      EXCLUDE_LITERAL
        ? "あいまい検索セクション相当（本文にクエリ語を含む文書を除外）"
        : "コーパス全体（hybrid モード・一致セクション込みの総合力）"
    }`,
    "",
  ];

  // 除外の有無で順位そのものが変わる。ここを書かないと後から読んだ人が必ず誤解する。
  if (EXCLUDE_LITERAL) {
    lines.push(
      "> **ILIKE 除外モードで測った数字です。** 本番の `semanticConditions` と同じく、",
      "> 本文にクエリ語をそのまま含む文書を候補から落としています（一致セクションと排他のため）。",
      "> 既定モードの数字とは順位が変わるので、混ぜて比較しないこと。",
      "",
    );
  }

  if (JUDGE_MODE !== "human") {
    lines.push(
      "> **この数字はまだ暫定です。** LLM-as-judge は日本語の固有名詞で判定がぶれます。",
      "> review.md を人手で確認し、`--judge=human` で再集計した数字で判断してください。",
      "",
    );
  }

  lines.push(
    "## 全体",
    "",
    "| アーム | nDCG@10 | P@1 | P@5 | MRR | Recall@20 | 依存 | 説明 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const row of rows) {
    const mark = row.arm === "arctic+trgm" ? " ⬅ 現行本番" : "";
    lines.push(
      `| \`${row.arm}\`${mark} | ${fmt(row.ndcg10)} | ${fmt(row.p1)} | ${fmt(row.p5)} | ${fmt(row.mrr)} | ${fmt(row.recall20)} | ${row.deps} | ${row.label} |`,
    );
  }

  lines.push("", "## カテゴリ別 nDCG@10", "");
  lines.push(`| アーム | ${categories.join(" | ")} |`);
  lines.push(`| --- | ${categories.map(() => "---:").join(" | ")} |`);
  for (const row of rows) {
    lines.push(
      `| \`${row.arm}\` | ${categories.map((c) => fmt(row.perCategory[c] ?? 0)).join(" | ")} |`,
    );
  }

  if (baseline) {
    lines.push(
      "",
      "## 判断",
      "",
      "置き換えに進む条件は次の2つを**同時に**満たすこと（プラン記載の基準）:",
      "",
      "1. `proper-noun` の nDCG@10 が現行本番 `arctic+trgm` より明確に上",
      "2. 全カテゴリ平均の nDCG@10 が現行本番より劣化していない",
      "",
      `現行本番: nDCG@10 = ${fmt(baseline.ndcg10)} / proper-noun = ${fmt(baseline.perCategory["proper-noun"] ?? 0)}`,
      "",
      "| アーム | 全体差分 | proper-noun 差分 | 条件 | 依存 |",
      "| --- | ---: | ---: | --- | --- |",
    );
    for (const row of rows) {
      if (row.arm === baseline.arm) continue;
      const overall = row.ndcg10 - baseline.ndcg10;
      const proper =
        (row.perCategory["proper-noun"] ?? 0) - (baseline.perCategory["proper-noun"] ?? 0);
      const pass = proper > 0 && overall >= 0 ? "✅" : "—";
      const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
      lines.push(
        `| \`${row.arm}\` | ${sign(overall)} | ${sign(proper)} | ${pass} | ${row.deps} |`,
      );
    }
  }

  lines.push("", "## 埋め込み生成の実測時間", "");
  lines.push("| エンコーダ | ms |", "| --- | ---: |");
  for (const [id, ms] of Object.entries(result.encoderLatencyMs)) {
    lines.push(`| \`${id}\` | ${Math.round(ms)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

function armDeps(arm: Arm, byId: Map<string, Arm>): string {
  const deps = new Set<string>();
  const visit = (target: Arm) => {
    if (target.dense) {
      const encoder = encoderById.get(target.dense);
      if (encoder) deps.add(encoder.provider);
    }
    if (target.sparse) deps.add("sidecar");
    if (target.rerank) deps.add("sidecar");
    if (target.lexical) deps.add("postgres");
    const base = target.base ? byId.get(target.base) : undefined;
    if (base) visit(base);
  };
  visit(arm);
  return [...deps].sort().join("+") || "—";
}

function printPlan(arms: Arm[], queries: EvalQuery[], byId: Map<string, Arm>): void {
  const encoders = [...new Set(arms.flatMap((a) => (a.dense ? [a.dense] : [])))];
  console.log("=== 埋め込みモデル評価: ドライラン（外部通信なし） ===\n");
  console.log(`コーパス       : ${SOURCE} / 最大 ${CORPUS_LIMIT} 件（本番DBから read-only）`);
  console.log(`クエリ         : ${queries.length} 件`);
  console.log(`出力先         : ${OUT_DIR}`);
  console.log(`キャッシュ     : ${CACHE_DIR}`);
  console.log(`サイドカー     : ${SIDECAR_URL}`);
  console.log(`採点モデル     : ${JUDGE_MODEL}`);
  console.log(`Gemini         : ${WITH_GEMINI ? `有効（上限 ${GEMINI_CALL_CAP} 回）` : "無効（--with-gemini で開く）"}\n`);

  console.log("--- エンコーダ ---");
  for (const id of encoders) {
    const encoder = encoderById.get(id);
    if (!encoder) continue;
    console.log(
      `  ${id.padEnd(12)} ${encoder.provider.padEnd(8)} ${String(encoder.dim).padStart(4)}d  ${encoder.model}`,
    );
    console.log(
      `  ${" ".repeat(12)} doc="${encoder.docPrefix}" query="${encoder.queryPrefix.replace(/\n/g, "\\n")}"`,
    );
  }

  console.log("\n--- アーム ---");
  for (const arm of arms) {
    console.log(`  [T${arm.tier}] ${arm.id.padEnd(22)} ${armDeps(arm, byId).padEnd(18)} ${arm.label}`);
  }
  console.log(`\n合計 ${arms.length} アーム。実行するには --run を付けてください。`);
}

type EncoderVectors = { docs: Float32Array[]; queries: Map<string, Float32Array> };

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const queries = await loadQueries();
  if (!queries.length) throw new Error("クエリが0件（--queries= の指定を確認してください）");

  const allArms = buildArms();
  const armById = new Map(allArms.map((a) => [a.id, a]));
  const selected = ARM_FILTER ? allArms.filter((a) => ARM_FILTER.includes(a.id)) : allArms;
  const arms = withBases(selected, allArms);

  if (!RUN && JUDGE_MODE !== "human") {
    printPlan(arms, queries, armById);
    return;
  }

  // --judge=human 単独: 既存の result.json と人手採点済み review.md で再集計するだけ。
  if (!RUN) {
    const result = JSON.parse(
      await readFile(path.join(OUT_DIR, "result.json"), "utf8"),
    ) as EvaluationResult;
    const review = await readFile(path.join(OUT_DIR, "review.md"), "utf8");
    result.judgments.human = parseReview(review, result);
    await writeFile(path.join(OUT_DIR, "result.json"), JSON.stringify(result, null, 2), "utf8");
    await writeFile(path.join(OUT_DIR, "summary.md"), renderSummary(result), "utf8");
    const judged = Object.values(result.judgments.human).reduce(
      (sum, byDoc) => sum + Object.keys(byDoc).length,
      0,
    );
    console.log(`人手採点 ${judged} 件で再集計しました → ${path.join(OUT_DIR, "summary.md")}`);
    return;
  }

  // -- コーパス --------------------------------------------------------------
  const corpusCacheName = `corpus-${SOURCE}-${CORPUS_LIMIT}.json`;
  let corpus = await readJsonCache<CorpusDoc[]>(corpusCacheName);
  if (!corpus) {
    console.log(`本番DBからコーパスを取得中（${SOURCE}, 最大 ${CORPUS_LIMIT} 件）…`);
    corpus = await loadCorpus(SOURCE);
    await writeJsonCache(corpusCacheName, corpus);
  }
  if (!corpus.length) throw new Error("コーパスが0件");
  const corpusHash = digest(corpus.map((d) => d.id).join("\n"));
  const indexById = new Map(corpus.map((doc, i) => [doc.id, i]));
  console.log(`コーパス ${corpus.length} 件 (hash ${corpusHash})`);

  // -- 依存の疎通確認 --------------------------------------------------------
  const sidecarUp = await sidecarAvailable();
  if (!sidecarUp) {
    console.warn(
      `[WARN] サイドカー ${SIDECAR_URL} に届きません。ruri-v3 / e5 / bge-m3 sparse / リランカーのアームは飛ばします。`,
    );
  }

  const usable = (arm: Arm): boolean => {
    const encoder = arm.dense ? encoderById.get(arm.dense) : undefined;
    if (encoder?.provider === "sidecar" && !sidecarUp) return false;
    if (encoder?.provider === "gemini" && !WITH_GEMINI) return false;
    if ((arm.sparse || arm.rerank) && !sidecarUp) return false;
    const base = arm.base ? armById.get(arm.base) : undefined;
    return base ? usable(base) : true;
  };

  const runnable = arms.filter(usable);
  for (const arm of arms) {
    if (!runnable.includes(arm)) console.warn(`[SKIP] ${arm.id} (${armDeps(arm, armById)} が使えません)`);
  }
  if (!runnable.length) throw new Error("実行できるアームがありません");

  // -- dense 埋め込み --------------------------------------------------------
  const encoderIds = [...new Set(runnable.flatMap((a) => (a.dense ? [a.dense] : [])))];
  const vectors = new Map<string, EncoderVectors>();
  const encoderLatencyMs: Record<string, number> = {};

  for (const id of encoderIds) {
    const encoder = encoderById.get(id)!;
    // 同じモデル・同じ文書接頭辞なら文書側ベクトルは同一なので、キャッシュを共有する。
    const cacheName = `emb-${SOURCE}-${corpusHash}-${digest(`${encoder.provider}:${encoder.model}:${encoder.docPrefix}`)}.bin`;
    let docs = await readVectorCache(cacheName, encoder.dim);
    if (!docs) {
      console.log(`埋め込み生成: ${id} (${encoder.model}) …`);
      const started = Date.now();
      docs = await encode(encoder, corpus.map((d) => `${encoder.docPrefix}${d.text}`));
      encoderLatencyMs[id] = Date.now() - started;
      await writeVectorCache(cacheName, docs);
    } else {
      console.log(`埋め込みキャッシュ命中: ${id}`);
    }
    // 拡張はクエリ側だけ。文書側は上のキャッシュをそのまま使うので再埋め込みは起きない。
    const expanded = encoder.expandQuery
      ? await expandQueries(encoder.expandQuery, queries)
      : null;
    const queryVectors = await encode(
      encoder,
      queries.map(
        (q) => `${encoder.queryPrefix}${expanded?.get(q.id) ?? q.text}`,
      ),
    );
    vectors.set(id, {
      docs,
      queries: new Map(queries.map((q, i) => [q.id, queryVectors[i]])),
    });
  }

  // -- sparse ----------------------------------------------------------------
  let sparseIndex: Map<string, Array<[number, number]>> | null = null;
  const querySparse = new Map<string, SparseVec>();
  if (runnable.some((a) => a.sparse)) {
    const cacheName = `sparse-${SOURCE}-${corpusHash}.json`;
    let raw = await readJsonCache<Record<string, number>[]>(cacheName);
    if (!raw) {
      console.log("bge-m3 sparse を生成中…");
      const encoded = await sparseEncode(corpus.map((d) => d.text));
      raw = encoded.map((m) => Object.fromEntries(m));
      await writeJsonCache(cacheName, raw);
    } else {
      console.log("sparse キャッシュ命中");
    }
    sparseIndex = buildSparseIndex(raw.map((r) => new Map(Object.entries(r))));
    const encodedQueries = await sparseEncode(queries.map((q) => q.text));
    queries.forEach((q, i) => querySparse.set(q.id, encodedQueries[i]));
  }

  // -- pg_trgm ---------------------------------------------------------------
  const lexical = new Map<string, Float32Array>();
  if (runnable.some((a) => a.lexical)) {
    const cacheName = `lex-${SOURCE}-${corpusHash}.json`;
    const cached = (await readJsonCache<Record<string, Record<string, number>>>(cacheName)) ?? {};
    let dirty = false;
    for (const query of queries) {
      if (!cached[query.id]) {
        console.log(`pg_trgm similarity: ${query.id}`);
        cached[query.id] = Object.fromEntries(
          await lexicalScores(SOURCE, corpus.map((d) => d.id), query.text),
        );
        dirty = true;
      }
      const scores = new Float32Array(corpus.length);
      for (const [docId, sim] of Object.entries(cached[query.id])) {
        const index = indexById.get(docId);
        if (index !== undefined) scores[index] = sim;
      }
      lexical.set(query.id, scores);
    }
    if (dirty) await writeJsonCache(cacheName, cached);
  }

  // -- ランキング ------------------------------------------------------------
  // dense スコアはエンコーダ単位で使い回す（同じベクトルを複数アームが共有するため）。
  const denseCache = new Map<string, Float32Array>();
  const denseFor = (encoderId: string, query: EvalQuery): Float32Array => {
    const key = `${encoderId}::${query.id}`;
    let scores = denseCache.get(key);
    if (!scores) {
      const entry = vectors.get(encoderId)!;
      scores = denseScores(entry.docs, entry.queries.get(query.id)!);
      denseCache.set(key, scores);
    }
    return scores;
  };

  const rankings: Record<string, Record<string, ArmHit[]>> = {};
  const plain = runnable.filter((a) => !a.rerank);
  const reranked = runnable.filter((a) => a.rerank);

  for (const arm of plain) {
    rankings[arm.id] = {};
    for (const query of queries) {
      const signals: Partial<Record<SignalName, Float32Array>> = {};
      if (arm.dense) signals.dense = denseFor(arm.dense, query);
      if (arm.sparse && sparseIndex) {
        signals.sparse = sparseScores(sparseIndex, querySparse.get(query.id)!, corpus.length);
      }
      if (arm.lexical) signals.lexical = lexical.get(query.id)!;
      rankings[arm.id][query.id] = rankArm(
        arm,
        corpus,
        signals,
        EXCLUDE_LITERAL ? query.text : undefined,
      );
    }
    console.log(`ランキング完了: ${arm.id}`);
  }

  for (const arm of reranked) {
    const base = rankings[arm.base!];
    if (!base) {
      console.warn(`[SKIP] ${arm.id}: 土台 ${arm.base} の結果がありません`);
      continue;
    }
    rankings[arm.id] = {};
    for (const query of queries) {
      const hits = base[query.id] ?? [];
      if (!hits.length) {
        rankings[arm.id][query.id] = [];
        continue;
      }
      const texts = hits.map((h) => corpus[indexById.get(h.id)!].text);
      const scores = await sidecarRerank(arm.rerank!, query.text, texts);
      rankings[arm.id][query.id] = hits
        .map((hit, i) => ({ ...hit, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    console.log(`ランキング完了: ${arm.id}`);
  }

  // -- プール（採点対象） ----------------------------------------------------
  const pool: Record<string, PoolEntry[]> = {};
  queries.forEach((query, qi) => {
    const ids = new Set<string>();
    for (const arm of runnable) {
      for (const hit of (rankings[arm.id]?.[query.id] ?? []).slice(0, POOL_DEPTH)) {
        ids.add(hit.id);
      }
    }
    const shuffled = seededShuffle([...ids], query.id);
    pool[query.id] = shuffled.map((docId, di) => ({
      key: `q${String(qi + 1).padStart(2, "0")}-d${String(di + 1).padStart(2, "0")}`,
      docId,
      text: corpus![indexById.get(docId)!].text,
    }));
  });

  // -- LLM 下書き採点 --------------------------------------------------------
  const judgeCacheName = `judgments-${SOURCE}-${corpusHash}.json`;
  const judgeCache = (await readJsonCache<Record<string, number>>(judgeCacheName)) ?? {};
  const llmJudgments: Judgments = {};
  if (JUDGE_MODE === "llm") {
    for (const query of queries) {
      const entries = pool[query.id];
      const pending = entries.filter((e) => judgeCache[`${query.id}::${e.docId}`] === undefined);
      if (pending.length) {
        console.log(`LLM 採点: ${query.id} (${pending.length} 件)`);
        const scored = await llmJudge(
          query,
          pending.map((e) => ({ id: e.docId, text: e.text })),
        );
        for (const [docId, score] of scored) judgeCache[`${query.id}::${docId}`] = score;
      }
      llmJudgments[query.id] = Object.fromEntries(
        entries.map((e) => [e.docId, judgeCache[`${query.id}::${e.docId}`] ?? 0]),
      );
    }
    await writeJsonCache(judgeCacheName, judgeCache);
  } else {
    for (const query of queries) {
      llmJudgments[query.id] = Object.fromEntries(pool[query.id].map((e) => [e.docId, 0]));
    }
  }

  // -- 出力 ------------------------------------------------------------------
  const result: EvaluationResult = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    corpusSize: corpus.length,
    corpusHash,
    judgeModel: JUDGE_MODE === "llm" ? JUDGE_MODEL : "(未採点)",
    arms: runnable.map((arm) => ({
      id: arm.id,
      label: arm.label,
      tier: arm.tier,
      note: arm.note,
      deps: armDeps(arm, armById),
    })),
    queries,
    rankings: Object.fromEntries(
      Object.entries(rankings).map(([armId, byQuery]) => [
        armId,
        Object.fromEntries(
          Object.entries(byQuery).map(([queryId, hits]) => [
            queryId,
            hits.slice(0, REPORT_DEPTH),
          ]),
        ),
      ]),
    ),
    pool,
    judgments: { llm: llmJudgments },
    encoderLatencyMs,
  };

  // --resume 時は前回の人手採点を引き継ぐ（せっかくの採点を捨てない）。
  if (RESUME) {
    try {
      const previous = JSON.parse(
        await readFile(path.join(OUT_DIR, "result.json"), "utf8"),
      ) as EvaluationResult;
      if (previous.judgments.human) result.judgments.human = previous.judgments.human;
    } catch {
      /* 前回結果なし。無視してよい。 */
    }
  }

  await writeFile(path.join(OUT_DIR, "result.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(path.join(OUT_DIR, "review.md"), renderReview(result), "utf8");
  await writeFile(path.join(OUT_DIR, "summary.md"), renderSummary(result), "utf8");

  console.log(`\n完了。${OUT_DIR} に result.json / review.md / summary.md を書きました。`);
  console.log("次: review.md を人手で採点し、--judge=human で再集計してください。");
}

// テストからは buildJudgeRequestBody / parseReview だけを import したいので、
// 直接実行されたときにだけ main() を回す。
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      // postgres.js のプールを閉じないとプロセスが終わらない。
      await client.end({ timeout: 5 }).catch(() => {});
    });
}
