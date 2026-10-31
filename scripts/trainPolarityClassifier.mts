/**
 * 定型リプ3値分類（positive / neutral / negative）を、埋め込み＋ロジスティック回帰で
 * 置き換えられるかを測る学習・評価スクリプト（Issue #126）。
 *
 * 教師データは本番の `affirmative_bot.polarity_samples`（LLM の判定ラベルと文書側の埋め込み。
 * 本文と DID は持たない）。content_hash の先頭から決まるバケットで分け、同じ投稿が学習と
 * 評価の両方に入らないようにする。
 *
 *   バケット 0-1 → 評価（約2割）
 *   バケット 2   → L2 の強さを選ぶ検証用（約1割、選んだあとは学習へ戻す）
 *   バケット 3-9 → 学習
 *
 * 使い方:
 *   # 本番 DB はトンネル（.220 なら 127.0.0.1:15432）経由。読み取りだけ。
 *   POLARITY_DATABASE_URL=postgres://... pnpm polarity:train
 *
 *   # 人手ラベル（scripts/fixtures/predefinedReplyEvaluationCases.json の3値48件）でも測る。
 *   # --llm-baseline を付けると同じ48件を今の LLM 分類にもかける（生成 Ollama を48回呼ぶ）。
 *   OLLAMA_EMBED_BASE_URL=... OLLAMA_BASE_URL=... pnpm polarity:train -- --fixtures --llm-baseline
 *
 * 出力:
 *   --out（既定 docs/evaluations/polarity-classifier/<日付>）に summary.md と metrics.json
 *   --model（既定 .cache/polarity-classifier/model.json）に重み
 *
 * 取得した埋め込みは .cache/polarity-classifier/ に置き、2回目以降は DB を読まない
 * （--refresh で取り直す）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import {
  hashBucket,
  predictProba,
  trainSoftmax,
  type PolaritySoftmaxModel,
} from "./lib/polaritySoftmax.mts";

const LABELS = ["negative", "neutral", "positive"] as const;
type Label = (typeof LABELS)[number];
const LABEL_VERSION = "three-way-v1";
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 1024;
const L2_CANDIDATES = [1e-3, 1e-2, 3e-2, 1e-1];
const CURVE_SIZES = [1000, 2000, 4000, 8000];
const THRESHOLDS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
const CACHE_DIR = path.resolve(".cache/polarity-classifier");
const FIXTURE_PATH = path.resolve(
  "scripts/fixtures/predefinedReplyEvaluationCases.json",
);

type Sample = {
  hash: string;
  language: string;
  label: number;
  x: Float32Array;
};

const hasArg = (name: string): boolean => process.argv.includes(name);
const argValue = (name: string): string | undefined =>
  process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const today = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(
  argValue("--out") ?? `docs/evaluations/polarity-classifier/${today}`,
);
const modelPath = path.resolve(
  argValue("--model") ?? path.join(CACHE_DIR, "model.json"),
);

async function loadSamples(): Promise<Sample[]> {
  const metaPath = path.join(CACHE_DIR, "samples.json");
  const vectorPath = path.join(CACHE_DIR, "samples.f32");
  if (!hasArg("--refresh")) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Array<
        Omit<Sample, "x">
      >;
      const buffer = await readFile(vectorPath);
      const vectors = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 4,
      );
      console.log(`[cache] ${meta.length} samples from ${CACHE_DIR}`);
      return meta.map((row, i) => ({
        ...row,
        x: vectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS),
      }));
    } catch {
      // キャッシュが無ければ DB から取る
    }
  }

  const url = process.env.POLARITY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("POLARITY_DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<
      Array<{ content_hash: string; language_name: string; label: Label; embedding: string }>
    >`
      select content_hash, language_name, label, embedding::text as embedding
        from affirmative_bot.polarity_samples
       where label_version = ${LABEL_VERSION}
         and embedding_model = ${EMBEDDING_MODEL}
       order by content_hash`;
    const vectors = new Float32Array(rows.length * DIMENSIONS);
    const samples = rows.map((row, i) => {
      const values = JSON.parse(row.embedding) as number[];
      if (values.length !== DIMENSIONS) {
        throw new Error(`unexpected dimensions: ${values.length}`);
      }
      vectors.set(values, i * DIMENSIONS);
      return {
        hash: row.content_hash,
        language: row.language_name,
        label: LABELS.indexOf(row.label),
        x: vectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS),
      };
    });
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      metaPath,
      JSON.stringify(samples.map(({ x: _x, ...rest }) => rest)),
    );
    await writeFile(vectorPath, Buffer.from(vectors.buffer));
    console.log(`[db] ${samples.length} samples`);
    return samples;
  } finally {
    await sql.end();
  }
}

type Prediction = { label: number; confidence: number };

const predict = (model: PolaritySoftmaxModel, x: ArrayLike<number>): Prediction => {
  const proba = predictProba(model, x);
  let best = 0;
  for (let c = 1; c < proba.length; c++) if (proba[c] > proba[best]) best = c;
  return { label: best, confidence: proba[best] };
};

const train = (samples: Sample[], l2: number) =>
  trainSoftmax(
    samples.map((sample) => sample.x),
    samples.map((sample) => sample.label),
    [...LABELS],
    { classes: LABELS.length, l2 },
  );

const accuracy = (model: PolaritySoftmaxModel, samples: Sample[]): number =>
  samples.length === 0
    ? NaN
    : samples.filter((sample) => predict(model, sample.x).label === sample.label)
        .length / samples.length;

type Report = {
  n: number;
  accuracy: number;
  macroF1: number;
  perClass: Record<Label, { precision: number; recall: number; support: number }>;
  confusion: number[][];
};

function report(predictions: Prediction[], truth: number[]): Report {
  const confusion = LABELS.map(() => LABELS.map(() => 0));
  predictions.forEach((prediction, i) => confusion[truth[i]][prediction.label]++);
  const perClass = {} as Report["perClass"];
  let f1Sum = 0;
  LABELS.forEach((label, c) => {
    const tp = confusion[c][c];
    const support = confusion[c].reduce((a, b) => a + b, 0);
    const predicted = confusion.reduce((a, row) => a + row[c], 0);
    const precision = predicted ? tp / predicted : 0;
    const recall = support ? tp / support : 0;
    f1Sum += precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[label] = { precision, recall, support };
  });
  const correct = LABELS.reduce((sum, _l, c) => sum + confusion[c][c], 0);
  return {
    n: truth.length,
    accuracy: truth.length ? correct / truth.length : NaN,
    macroF1: f1Sum / LABELS.length,
    perClass,
    confusion,
  };
}

/**
 * しきい値以上の確信度だけ分類器で決め、残りを LLM に回したときの姿。
 * 評価データの正解は LLM のラベルそのものなので、LLM に回した分は一致として数える。
 */
function thresholdTable(predictions: Prediction[], truth: number[]) {
  return THRESHOLDS.map((threshold) => {
    let covered = 0;
    let coveredCorrect = 0;
    let negativeTotal = 0;
    let negativeMissed = 0;
    predictions.forEach((prediction, i) => {
      const handled = prediction.confidence >= threshold;
      if (truth[i] === 0) negativeTotal++;
      if (!handled) return;
      covered++;
      if (prediction.label === truth[i]) coveredCorrect++;
      else if (truth[i] === 0) negativeMissed++;
    });
    const n = truth.length;
    return {
      threshold,
      classifierShare: covered / n,
      llmShare: 1 - covered / n,
      coveredAccuracy: covered ? coveredCorrect / covered : NaN,
      overallAgreement: (coveredCorrect + (n - covered)) / n,
      negativeMissRate: negativeTotal ? negativeMissed / negativeTotal : NaN,
    };
  });
}

type FixtureCase = {
  id: string;
  languageName: string;
  text: string;
  expectedLabel: string;
};

async function evaluateFixtures(model: PolaritySoftmaxModel) {
  const { generateEmbeddings } = await import(
    "../packages/database/src/ollamaEmbed.ts"
  );
  const raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as
    | FixtureCase[]
    | { cases: FixtureCase[] };
  const cases = (Array.isArray(raw) ? raw : raw.cases).filter((item) =>
    (LABELS as readonly string[]).includes(item.expectedLabel),
  );
  // 本番の収集（polaritySamples.ts）と同じく、文書側・前後の空白なしで埋め込む。
  const embeddings = await generateEmbeddings(cases.map((item) => item.text.trim()));
  if (embeddings.some((embedding) => !embedding)) {
    throw new Error("fixture embedding failed (OLLAMA_EMBED_BASE_URL?)");
  }

  let classifyPolarityOllama: ((text: string) => Promise<Label>) | undefined;
  if (hasArg("--llm-baseline")) {
    ({ classifyPolarityOllama } = await import(
      "../packages/bot_brain/src/predefinedReplyPipeline.ts"
    ));
  }

  const rows = [];
  for (const [i, item] of cases.entries()) {
    const prediction = predict(model, embeddings[i]!);
    let llm: Label | "error" | null = null;
    if (classifyPolarityOllama) {
      try {
        llm = await classifyPolarityOllama(item.text);
      } catch {
        llm = "error";
      }
    }
    rows.push({
      id: item.id,
      language: item.languageName,
      expected: item.expectedLabel as Label,
      classifier: LABELS[prediction.label],
      confidence: prediction.confidence,
      llm,
    });
  }
  return rows;
}

const pct = (value: number) => (Number.isNaN(value) ? "-" : `${(value * 100).toFixed(1)}%`);

async function main() {
  const samples = (await loadSamples()).filter((sample) => sample.label >= 0);
  const evalSet = samples.filter((sample) => hashBucket(sample.hash) <= 1);
  const validation = samples.filter((sample) => hashBucket(sample.hash) === 2);
  const trainOnly = samples.filter((sample) => hashBucket(sample.hash) >= 3);
  console.log(
    `train=${trainOnly.length} validation=${validation.length} eval=${evalSet.length}`,
  );

  const l2Scores = [];
  for (const l2 of L2_CANDIDATES) {
    const started = Date.now();
    const score = accuracy(train(trainOnly, l2), validation);
    l2Scores.push({ l2, validationAccuracy: score });
    console.log(`[l2] ${l2} → ${pct(score)} (${Date.now() - started}ms)`);
  }
  const { l2 } = l2Scores.reduce((best, item) =>
    item.validationAccuracy > best.validationAccuracy ? item : best,
  );

  const trainSet = [...trainOnly, ...validation];
  const japaneseEval = evalSet.filter((sample) => sample.language === "日本語");
  const englishEval = evalSet.filter((sample) => sample.language === "English");

  // 学習曲線。trainSet は content_hash 順（＝無作為な並び）なので先頭から切る。
  const curve = [];
  for (const size of [...CURVE_SIZES.filter((s) => s < trainSet.length), trainSet.length]) {
    const subset = trainSet.slice(0, size);
    const model = train(subset, l2);
    const japanese = report(
      japaneseEval.map((sample) => predict(model, sample.x)),
      japaneseEval.map((sample) => sample.label),
    );
    const point = {
      size,
      accuracy: accuracy(model, evalSet),
      japaneseAccuracy: japanese.accuracy,
      japaneseNegativeRecall: japanese.perClass.negative.recall,
      englishAccuracy: accuracy(model, englishEval),
    };
    curve.push(point);
    console.log(
      `[curve] ${size} → all ${pct(point.accuracy)} ja ${pct(point.japaneseAccuracy)} ` +
        `ja-neg-recall ${pct(point.japaneseNegativeRecall)} en ${pct(point.englishAccuracy)}`,
    );
  }

  const model = train(trainSet, l2);
  await mkdir(path.dirname(modelPath), { recursive: true });
  await writeFile(
    modelPath,
    JSON.stringify({
      labelVersion: LABEL_VERSION,
      embeddingModel: EMBEDDING_MODEL,
      trainedAt: new Date().toISOString(),
      trainSize: trainSet.length,
      l2,
      ...model,
    }),
  );

  const slices: Record<string, Sample[]> = {
    all: evalSet,
    日本語: japaneseEval,
    English: englishEval,
    other: evalSet.filter(
      (sample) => sample.language !== "日本語" && sample.language !== "English",
    ),
  };
  const evaluation: Record<string, { report: Report; thresholds: ReturnType<typeof thresholdTable> }> = {};
  for (const [name, slice] of Object.entries(slices)) {
    const predictions = slice.map((sample) => predict(model, sample.x));
    const truth = slice.map((sample) => sample.label);
    evaluation[name] = {
      report: report(predictions, truth),
      thresholds: thresholdTable(predictions, truth),
    };
  }

  const fixtures = hasArg("--fixtures") ? await evaluateFixtures(model) : null;

  const metrics = {
    createdAt: new Date().toISOString(),
    labelVersion: LABEL_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    counts: {
      train: trainSet.length,
      eval: evalSet.length,
      byLanguage: Object.fromEntries(
        Object.entries(slices).map(([name, slice]) => [name, slice.length]),
      ),
    },
    l2Scores,
    l2,
    curve,
    evaluation,
    fixtures,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(path.join(outDir, "summary.md"), renderSummary(metrics));
  console.log(`wrote ${outDir} and ${modelPath}`);
}

function renderSummary(metrics: {
  counts: { train: number; eval: number; byLanguage: Record<string, number> };
  l2: number;
  curve: Array<{ size: number; accuracy: number; japaneseAccuracy: number; japaneseNegativeRecall: number; englishAccuracy: number }>;
  evaluation: Record<string, { report: Report; thresholds: ReturnType<typeof thresholdTable> }>;
  fixtures: Awaited<ReturnType<typeof evaluateFixtures>> | null;
}): string {
  const lines: string[] = [];
  lines.push(`# 定型リプ3値分類: 埋め込み＋ロジスティック回帰（${today}）`, "");
  lines.push(
    `- 教師: \`polarity_samples\`（${LABEL_VERSION} / ${EMBEDDING_MODEL}）。正解は LLM のラベル`,
    `- 学習 ${metrics.counts.train} 件 / 評価 ${metrics.counts.eval} 件（content_hash で分割）`,
    `- 評価の内訳: ${Object.entries(metrics.counts.byLanguage).map(([k, v]) => `${k} ${v}`).join("、")}`,
    `- L2 = ${metrics.l2}`,
    "",
    "## 学習曲線（評価データでの LLM との一致率）",
    "",
    "| 学習件数 | 全体 | 日本語 | 日本語 negative の再現率 | 英語 |",
    "|---:|---:|---:|---:|---:|",
    ...metrics.curve.map(
      (point) =>
        `| ${point.size} | ${pct(point.accuracy)} | ${pct(point.japaneseAccuracy)} | ${pct(point.japaneseNegativeRecall)} | ${pct(point.englishAccuracy)} |`,
    ),
    "",
  );
  for (const [name, { report: r, thresholds }] of Object.entries(metrics.evaluation)) {
    lines.push(
      `## ${name}（${r.n} 件）`,
      "",
      `一致率 ${pct(r.accuracy)}、macro F1 ${r.macroF1.toFixed(3)}`,
      "",
      "| LLM \\ 分類器 | negative | neutral | positive | 再現率 | 適合率 |",
      "|---|---:|---:|---:|---:|---:|",
      ...LABELS.map(
        (label, c) =>
          `| ${label} | ${r.confusion[c].join(" | ")} | ${pct(r.perClass[label].recall)} | ${pct(r.perClass[label].precision)} |`,
      ),
      "",
      "| 確信度しきい値 | 分類器で決める割合 | LLM に回す割合 | 決めた分の一致率 | LLM 併用時の一致率 | negative の取りこぼし |",
      "|---:|---:|---:|---:|---:|---:|",
      ...thresholds.map(
        (row) =>
          `| ${row.threshold} | ${pct(row.classifierShare)} | ${pct(row.llmShare)} | ${pct(row.coveredAccuracy)} | ${pct(row.overallAgreement)} | ${pct(row.negativeMissRate)} |`,
      ),
      "",
    );
  }
  if (metrics.fixtures) {
    const rows = metrics.fixtures;
    const hit = (pick: (row: (typeof rows)[number]) => string | null) =>
      rows.filter((row) => pick(row) === row.expected).length;
    lines.push(
      `## 人手ラベル（${FIXTURE_PATH.split("/").pop()} の3値 ${rows.length} 件）`,
      "",
      `- 分類器: ${hit((row) => row.classifier)}/${rows.length}`,
    );
    if (rows.some((row) => row.llm)) {
      lines.push(`- 今の LLM: ${hit((row) => row.llm)}/${rows.length}`);
    }
    lines.push(
      "",
      "| id | 言語 | 正解 | 分類器 | 確信度 | LLM |",
      "|---|---|---|---|---:|---|",
      ...rows.map(
        (row) =>
          `| ${row.id} | ${row.language} | ${row.expected} | ${row.classifier} | ${row.confidence.toFixed(2)} | ${row.llm ?? "-"} |`,
      ),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

await main();
