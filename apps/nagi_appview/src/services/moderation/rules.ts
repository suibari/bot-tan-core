/**
 * OpenAI omni-moderation のカテゴリスコアを Nagi の判定へ落とす層。
 *
 * 判定は4値。技術的な失敗（壊れた blob など）を規約違反と混ぜないために
 * reject-policy と reject-invalid を分けている。retry 相当は値では表さず、
 * 呼び出し側へ例外として投げてワーカーの次周回に任せる。
 */

export type ModerationDecision =
  | "allow"
  | "label"
  | "reject-policy"
  | "reject-invalid";

/** ルール変更時に上げる。値が変わった行はワーカーが拾い直して再判定する。 */
export const MODERATION_RULE_VERSION = "nagi-moderation-v2";

/** 判定対象外（こっそり投稿など）を表す番兵。ワーカーはこの行を拾わない。 */
export const MODERATION_SKIPPED = "skipped";

/**
 * この機能を入れる前からある行の番兵。未判定だが判定待ちにはしない。
 *
 * 既存レコードを一斉に判定待ちにするとワーカーが全件を OpenAI へ流して 429 になる
 * （開発環境で実際に起きた）ので、バックフィルはしない方針。編集されて cid が
 * 変われば applyMutation が NULL へ戻すので、その時点で判定対象になる。
 * 将来まとめて判定したくなったら、この値を狙って NULL に戻せばよい。
 */
export const MODERATION_LEGACY = "legacy";

export interface ModerationEvaluation {
  decision: ModerationDecision;
  labels: string[];
  reasons: string[];
  maxScore: number;
  highestCategory: string;
}

export interface ThresholdConfig {
  /** ラベル付与を行うスコア閾値。 */
  labelThreshold: number;
  /** 記録だけ残す境界スコア閾値。閾値調整の材料にする。 */
  observeThreshold: number;
  /** AppView へ投影しない（重大違反）とするスコア閾値。 */
  rejectThreshold: number;
  /** カテゴリ別の上書き。 */
  categoryOverrides?: Record<
    string,
    { label?: number; observe?: number; reject?: number }
  >;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  labelThreshold: 0.7,
  observeThreshold: 0.4,
  rejectThreshold: 0.92,
  categoryOverrides: {
    sexual: { label: 0.75, observe: 0.45, reject: 0.98 },
    "sexual/minors": { label: 0.1, observe: 0.05, reject: 0.2 }, // 児童保護は極めて厳格に
    hate: { label: 0.8, observe: 0.5, reject: 0.95 },
    "hate/threatening": { label: 0.5, observe: 0.3, reject: 0.85 },
    harassment: { label: 0.8, observe: 0.5, reject: 0.95 },
    "harassment/threatening": { label: 0.6, observe: 0.35, reject: 0.9 },
    "self-harm": { label: 0.7, observe: 0.4, reject: 0.9 },
    "self-harm/intent": { label: 0.5, observe: 0.3, reject: 0.85 },
    violence: { label: 0.8, observe: 0.5, reject: 0.95 },
    "violence/graphic": { label: 0.7, observe: 0.4, reject: 0.9 },
  },
};

/** AppView が表示側へ渡すラベル。これ以外の値は出さない。 */
export const MODERATION_LABEL_VALUES = new Set([
  "sexual",
  "nudity",
  "graphic-media",
  "hate",
  "harassment",
  "!warn",
  "!hide",
]);

/**
 * 未成年ビューアには AppView が返さないラベル。
 * クライアント設定では解除できない（サーバ側で行ごと落とす）。
 */
export const ADULT_LABELS = [
  "sexual",
  "nudity",
  "graphic-media",
  "!hide",
] as const;

/** OpenAI のカテゴリ名を Nagi のラベル名へ写す。 */
export function mapCategoryToLabel(category: string): string {
  if (category.startsWith("sexual/minors")) return "!hide";
  if (category.startsWith("sexual")) return "sexual";
  if (category.startsWith("hate")) return "hate";
  if (category.startsWith("harassment")) return "harassment";
  if (category.startsWith("self-harm")) return "!warn";
  if (category.startsWith("violence/graphic")) return "graphic-media";
  if (category.startsWith("violence")) return "!warn";
  return "!warn";
}

/** カテゴリスコアから decision を決める。 */
export function evaluateScores(
  categoryScores: Record<string, number>,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): ModerationEvaluation {
  let maxScore = 0;
  let highestCategory = "";
  const detectedLabels = new Set<string>();
  const reasons: string[] = [];

  let shouldReject = false;
  let shouldLabel = false;

  for (const [category, score] of Object.entries(categoryScores)) {
    if (score > maxScore) {
      maxScore = score;
      highestCategory = category;
    }

    const override = config.categoryOverrides?.[category];
    const rejectThresh = override?.reject ?? config.rejectThreshold;
    const labelThresh = override?.label ?? config.labelThreshold;
    const observeThresh = override?.observe ?? config.observeThreshold;

    const pct = (score * 100).toFixed(1);
    if (score >= rejectThresh) {
      shouldReject = true;
      reasons.push(`[REJECT] ${category}: ${pct}% (>= ${rejectThresh * 100}%)`);
      detectedLabels.add(mapCategoryToLabel(category));
    } else if (score >= labelThresh) {
      shouldLabel = true;
      reasons.push(`[LABEL] ${category}: ${pct}% (>= ${labelThresh * 100}%)`);
      detectedLabels.add(mapCategoryToLabel(category));
    } else if (score >= observeThresh) {
      reasons.push(`[OBSERVE] ${category}: ${pct}% (>= ${observeThresh * 100}%)`);
    }
  }

  const decision: ModerationDecision = shouldReject
    ? "reject-policy"
    : shouldLabel
      ? "label"
      : "allow";

  return {
    decision,
    labels: Array.from(detectedLabels).filter((label) =>
      MODERATION_LABEL_VALUES.has(label),
    ),
    reasons,
    maxScore,
    highestCategory,
  };
}
