import { ModerationResult } from "./openai.js";

export type ModerationActionType = "none" | "label" | "drop";

export interface EvaluationAction {
  action: ModerationActionType;
  labels: string[];
  reasons: string[];
  maxScore: number;
  highestCategory: string;
}

export interface ThresholdConfig {
  /** 即時ラベル付与を行うスコア閾値 (デフォルト: 0.70) */
  labelThreshold: number;
  /** 判定調整のために理由のみ記録する境界スコア閾値 (デフォルト: 0.40) */
  observeThreshold: number;
  /** AppView保存スキップ（重大違反）とするスコア閾値 (デフォルト: 0.90) */
  dropThreshold: number;
  /** カテゴリ別カスタム閾値設定 */
  categoryOverrides?: Record<
    string,
    { label?: number; observe?: number; drop?: number }
  >;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  labelThreshold: 0.7,
  observeThreshold: 0.4,
  dropThreshold: 0.92,
  categoryOverrides: {
    sexual: { label: 0.75, observe: 0.45, drop: 0.98 },
    "sexual/minors": { label: 0.1, observe: 0.05, drop: 0.2 }, // 児童保護は極めて厳格に
    hate: { label: 0.8, observe: 0.5, drop: 0.95 },
    "hate/threatening": { label: 0.5, observe: 0.3, drop: 0.85 },
    harassment: { label: 0.8, observe: 0.5, drop: 0.95 },
    "harassment/threatening": { label: 0.6, observe: 0.35, drop: 0.9 },
    "self-harm": { label: 0.7, observe: 0.4, drop: 0.9 },
    "self-harm/intent": { label: 0.5, observe: 0.3, drop: 0.85 },
    violence: { label: 0.8, observe: 0.5, drop: 0.95 },
    "violence/graphic": { label: 0.7, observe: 0.4, drop: 0.9 },
  },
};

/**
 * OpenAIのカテゴリ名をAT Protocolのラベル名にマッピング
 */
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

/**
 * ModerationResult を評価し、アクション（drop / label / none）を決定
 */
export function evaluateModerationResult(
  result: ModerationResult,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): EvaluationAction {
  const scores = result.categoryScores;
  let maxScore = 0;
  let highestCategory = "";
  const detectedLabels = new Set<string>();
  const reasons: string[] = [];

  let shouldDrop = false;
  let shouldLabel = false;

  for (const [category, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      highestCategory = category;
    }

    const override = config.categoryOverrides?.[category];
    const dropThresh = override?.drop ?? config.dropThreshold;
    const labelThresh = override?.label ?? config.labelThreshold;
    const observeThresh = override?.observe ?? config.observeThreshold;

    if (score >= dropThresh) {
      shouldDrop = true;
      reasons.push(
        `[DROP] ${category}: ${(score * 100).toFixed(1)}% (>= ${dropThresh * 100}%)`,
      );
      detectedLabels.add(mapCategoryToLabel(category));
    } else if (score >= labelThresh) {
      shouldLabel = true;
      reasons.push(
        `[LABEL] ${category}: ${(score * 100).toFixed(1)}% (>= ${labelThresh * 100}%)`,
      );
      detectedLabels.add(mapCategoryToLabel(category));
    } else if (score >= observeThresh) {
      reasons.push(
        `[OBSERVE] ${category}: ${(score * 100).toFixed(1)}% (>= ${observeThresh * 100}%)`,
      );
    }
  }

  let action: ModerationActionType = "none";
  if (shouldDrop) {
    action = "drop";
  } else if (shouldLabel) {
    action = "label";
  }

  return {
    action,
    labels: Array.from(detectedLabels),
    reasons,
    maxScore,
    highestCategory,
  };
}
