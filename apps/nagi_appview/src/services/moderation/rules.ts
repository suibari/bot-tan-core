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

/** ルール変更時に上げる。再処理をキューへ戻した行が同一 CID の旧判定を再利用しないための版。 */
export const MODERATION_RULE_VERSION = "nagi-moderation-v5";

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

/** 運用者の上書き。今は解除（allow）だけ。BAN を足すときはここへ加える。 */
export type ModerationOverride = "allow";

/**
 * 運用者の解除が今の内容に効くか。
 *
 * 上書きは押した時点の cid に結び付ける。編集されて cid が変わった内容は運用者が
 * 見ていないので、通常の判定へ戻す。
 */
export function allowOverrideApplies(
  row: { override: string | null; overrideCid: string | null } | undefined,
  cid: string,
): boolean {
  return row?.override === "allow" && row.overrideCid === cid;
}

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

/**
 * 本文では記録だけ残し、ラベルも拒否もしないカテゴリ。
 *
 * - violence / violence/graphic: 感想や引用でも高得点になる。
 * - sexual/minors: 「生徒会」「令嬢」のような語と性的な語が並ぶだけで上がる。
 *   2026-11-09「生徒会にも穴がある、の5話が…性癖に刺さる」が 0.197 で !hide に
 *   なり、それまでに付いた2件はどちらも誤判定だった。画像側は従来どおり厳格に見る。
 */
export const TEXT_OBSERVE_ONLY_CATEGORIES: readonly string[] = [
  "violence",
  "violence/graphic",
  "sexual/minors",
];

/**
 * 生成の入力（絵文字生成のプロンプトなど）で記録だけにするカテゴリ。
 * 投稿と違い、ここを通った文から画像が作られるので sexual/minors は止めたままにする。
 */
export const GENERATION_OBSERVE_ONLY_CATEGORIES: readonly string[] = [
  "violence",
  "violence/graphic",
];

/** 露骨な語に当たったときに判定テーブルへ残すカテゴリ名。OpenAI のスコア由来と見分けるため。 */
export const EXPLICIT_TERM_CATEGORY = "sexual/keyword";

/**
 * カテゴリスコアから decision を決める。
 * observeOnly に入ったカテゴリは閾値を超えても記録（OBSERVE）だけにする。
 */
export function evaluateScores(
  categoryScores: Record<string, number>,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
  observeOnly: readonly string[] = [],
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
    if (observeOnly.includes(category)) {
      if (score >= observeThresh)
        reasons.push(`[OBSERVE] ${category}: ${pct}% (text; no restriction)`);
    } else if (score >= rejectThresh) {
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

export interface SeparatedScoreOptions {
  /** 本文で記録だけにするカテゴリ。既定は投稿向けの TEXT_OBSERVE_ONLY_CATEGORIES。 */
  textObserveOnly?: readonly string[];
  /** 本文に含まれていた露骨な語（findExplicitTerms の結果）。1つでもあれば sexual を付ける。 */
  explicitTerms?: readonly string[];
}

/** 本文・画像を別々に評価してから、強い方の判定を採用する。 */
export function evaluateSeparatedScores(
  scores: {
    text: Record<string, number>;
    image: Record<string, number>;
  },
  options: SeparatedScoreOptions = {},
): ModerationEvaluation {
  const text = evaluateScores(
    scores.text,
    DEFAULT_THRESHOLDS,
    options.textObserveOnly ?? TEXT_OBSERVE_ONLY_CATEGORIES,
  );
  const image = evaluateScores(scores.image, DEFAULT_THRESHOLDS);
  const highest = text.maxScore > image.maxScore ? text : image;
  const scored: ModerationEvaluation = {
    decision: [text, image].some(value => value.decision === "reject-policy")
      ? "reject-policy"
      : [text, image].some(value => value.decision === "label") ? "label" : "allow",
    labels: [...new Set([...text.labels, ...image.labels])],
    reasons: [
      ...text.reasons.map(reason => `[TEXT] ${reason}`),
      ...image.reasons.map(reason => `[IMAGE] ${reason}`),
    ],
    maxScore: highest.maxScore,
    highestCategory: highest.highestCategory,
  };
  return applyExplicitTerms(scored, options.explicitTerms ?? []);
}

/**
 * 露骨な語の照合結果を判定へ重ねる。sexual ラベルを足し、allow なら label へ上げる。
 *
 * スコア側だけで既にラベルか拒否になっているなら、その最高カテゴリを残す。
 * 語句だけで付いたときは category を sexual/keyword・score を 1 にして、
 * 判定テーブル上で OpenAI 由来のラベルと見分けられるようにする。
 */
function applyExplicitTerms(
  evaluation: ModerationEvaluation,
  terms: readonly string[],
): ModerationEvaluation {
  if (!terms.length) return evaluation;
  const keywordOnly = evaluation.decision === "allow";
  return {
    decision: keywordOnly ? "label" : evaluation.decision,
    labels: [...new Set([...evaluation.labels, "sexual"])],
    reasons: [
      ...evaluation.reasons,
      `[TEXT] [KEYWORD] sexual: ${terms.join(", ")}`,
    ],
    maxScore: keywordOnly ? 1 : evaluation.maxScore,
    highestCategory: keywordOnly ? EXPLICIT_TERM_CATEGORY : evaluation.highestCategory,
  };
}
