/**
 * 定型リプ3値分類の軽量分類器（多クラスロジスティック回帰）。
 *
 * 学習は全件一括の Adam。凸問題なので重みの初期値は0でよく、結果は入力順に依存しない。
 * 特徴量は学習データの平均と標準偏差で標準化して学習し、保存前に重みへ畳み込む。
 * 推論側は `softmax(W·x + b)` だけで済み、標準化の統計量を持ち回らなくてよい。
 */

export type PolaritySoftmaxModel = {
  labels: string[];
  /** labels と同じ並び。各行が埋め込みと同じ次元。 */
  weights: number[][];
  bias: number[];
};

export type TrainOptions = {
  classes: number;
  /** L2 正則化の強さ（標準化後の重みに掛かる）。 */
  l2: number;
  epochs?: number;
  learningRate?: number;
};

export function trainSoftmax(
  xs: ArrayLike<number>[],
  ys: number[],
  labels: string[],
  options: TrainOptions,
): PolaritySoftmaxModel {
  const n = xs.length;
  if (n === 0) throw new Error("trainSoftmax: no samples");
  const d = xs[0].length;
  const k = options.classes;
  const epochs = options.epochs ?? 400;
  const lr = options.learningRate ?? 0.01;

  const mean = new Float64Array(d);
  const std = new Float64Array(d);
  for (const x of xs) for (let j = 0; j < d; j++) mean[j] += x[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const x of xs) {
    for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
  }
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const z = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    for (let j = 0; j < d; j++) z[i * d + j] = (x[j] - mean[j]) / std[j];
  }

  const w = new Float64Array(k * d);
  const b = new Float64Array(k);
  const gw = new Float64Array(k * d);
  const gb = new Float64Array(k);
  const mw = new Float64Array(k * d);
  const vw = new Float64Array(k * d);
  const mb = new Float64Array(k);
  const vb = new Float64Array(k);
  const logits = new Float64Array(k);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;

  for (let epoch = 1; epoch <= epochs; epoch++) {
    gw.fill(0);
    gb.fill(0);
    for (let i = 0; i < n; i++) {
      const offset = i * d;
      for (let c = 0; c < k; c++) {
        let sum = b[c];
        const row = c * d;
        for (let j = 0; j < d; j++) sum += w[row + j] * z[offset + j];
        logits[c] = sum;
      }
      softmaxInPlace(logits);
      for (let c = 0; c < k; c++) {
        const g = logits[c] - (ys[i] === c ? 1 : 0);
        if (g === 0) continue;
        gb[c] += g;
        const row = c * d;
        for (let j = 0; j < d; j++) gw[row + j] += g * z[offset + j];
      }
    }
    const correction1 = 1 - beta1 ** epoch;
    const correction2 = 1 - beta2 ** epoch;
    for (let p = 0; p < k * d; p++) {
      const g = gw[p] / n + options.l2 * w[p];
      mw[p] = beta1 * mw[p] + (1 - beta1) * g;
      vw[p] = beta2 * vw[p] + (1 - beta2) * g * g;
      w[p] -= (lr * (mw[p] / correction1)) / (Math.sqrt(vw[p] / correction2) + eps);
    }
    for (let c = 0; c < k; c++) {
      const g = gb[c] / n;
      mb[c] = beta1 * mb[c] + (1 - beta1) * g;
      vb[c] = beta2 * vb[c] + (1 - beta2) * g * g;
      b[c] -= (lr * (mb[c] / correction1)) / (Math.sqrt(vb[c] / correction2) + eps);
    }
  }

  // 標準化を畳み込む: w·(x-μ)/σ + b = (w/σ)·x + (b - Σ w·μ/σ)
  const weights: number[][] = [];
  const bias: number[] = [];
  for (let c = 0; c < k; c++) {
    const row = new Array<number>(d);
    let shift = b[c];
    for (let j = 0; j < d; j++) {
      row[j] = w[c * d + j] / std[j];
      shift -= row[j] * mean[j];
    }
    weights.push(row);
    bias.push(shift);
  }
  return { labels, weights, bias };
}

export function predictProba(
  model: PolaritySoftmaxModel,
  x: ArrayLike<number>,
): number[] {
  const logits = new Float64Array(model.weights.length);
  for (let c = 0; c < model.weights.length; c++) {
    const row = model.weights[c];
    let sum = model.bias[c];
    for (let j = 0; j < row.length; j++) sum += row[j] * x[j];
    logits[c] = sum;
  }
  softmaxInPlace(logits);
  return Array.from(logits);
}

function softmaxInPlace(values: Float64Array): void {
  let max = -Infinity;
  for (const value of values) if (value > max) max = value;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.exp(values[i] - max);
    sum += values[i];
  }
  for (let i = 0; i < values.length; i++) values[i] /= sum;
}

/**
 * content_hash から決まる 0〜9 のバケット。同じ投稿は必ず同じ側へ入る。
 * sha256 の先頭なので、件数に対して一様に散る。
 */
export function hashBucket(contentHash: string): number {
  return Number.parseInt(contentHash.slice(0, 8), 16) % 10;
}
