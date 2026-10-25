import { ollamaChat } from "./ollamaChat.js";
import {
  predefinedAffirmation,
  type PredefinedAffirmationDependencies,
  type SentimentLabel,
} from "./predefinedAffirmation.js";
import specialRulesJson from "./predefinedReplySpecialRules.json" with {
  type: "json",
};

export type PolarityLabel = Extract<
  SentimentLabel,
  "negative" | "neutral" | "positive"
>;
export type SpecialLabel = Extract<
  SentimentLabel,
  "morning" | "night" | "gj" | "hny"
>;
export type PredefinedReplySelectorMode = "random" | "llm";

export type ProductionPredefinedReplyClassification = {
  method: "rules-ollama-three-way";
  label: SentimentLabel;
  latencyMs: number;
  llmCalls: number;
  specialRule: "direct" | null;
  error?: string;
};

export type ProductionPredefinedReplyDependencies = {
  classify?: typeof classifyProductionPredefinedReply;
  classifyThreeWay?: (text: string) => Promise<PolarityLabel>;
  affirm?: typeof predefinedAffirmation;
  random?: () => number;
  translate?: PredefinedAffirmationDependencies["translate"];
  now?: () => number;
  /** 分類が決まった直後に呼ぶ。返信の生成を待たせないよう、中で await しないこと。 */
  onClassified?: (classification: ProductionPredefinedReplyClassification) => void;
};

type SpecialRule = {
  label: SpecialLabel;
  mode: "phrase" | "short-slang";
  positions: Array<"start" | "end">;
  aliases: string[];
};

/**
 * THREE_WAY_PROMPT の版。教師データ（polarity_samples）のラベルの出どころを区別するので、
 * プロンプトの文言を変えたら上げること。
 */
export const THREE_WAY_LABEL_VERSION = "three-way-v1";

const THREE_WAY_PROMPT = `Classify the emotional sentiment of the user's text into exactly one category.
Reply with only one word: negative, neutral, or positive.
- negative: distress, disappointment, anger, complaints, or an overall negative experience
- positive: joy, gratitude, satisfaction, hope, or an overall positive experience
- neutral: factual statements, unclear/mixed sentiment, or content whose sentiment belongs to someone else
Understand negation, double negation, quotation, and sarcasm from the whole sentence.`;

const parsePolarity = (raw: string): PolarityLabel => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "negative") return "negative";
  if (normalized === "positive") return "positive";
  if (normalized === "neutral") return "neutral";
  throw new Error("Ollama returned an invalid three-way classification");
};

export async function classifyPolarityOllama(
  text: string,
): Promise<PolarityLabel> {
  const raw = await ollamaChat(
    "OLLAMA_PREDEFINED_AFFIRMATION",
    [
      { role: "system", content: THREE_WAY_PROMPT },
      { role: "user", content: text },
    ],
    { maxTokens: 5 },
  );
  return parsePolarity(raw);
}

const removeQuotedText = (text: string): string =>
  text
    .replace(/「[^」]*」|『[^』]*』/gu, " ")
    .replace(/"[^"]*"|'[^']*'/gu, " ");

const isSpecialRule = (value: unknown): value is SpecialRule => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SpecialRule>;
  return (
    ["morning", "night", "gj", "hny"].includes(candidate.label ?? "") &&
    (candidate.mode === "phrase" || candidate.mode === "short-slang") &&
    Array.isArray(candidate.positions) &&
    candidate.positions.length > 0 &&
    candidate.positions.every(
      (position) => position === "start" || position === "end",
    ) &&
    Array.isArray(candidate.aliases) &&
    candidate.aliases.length > 0 &&
    candidate.aliases.every(
      (alias) => typeof alias === "string" && alias.trim().length > 0,
    )
  );
};

const parsedSpecialRules = specialRulesJson as {
  version?: unknown;
  rules?: unknown;
};
if (
  parsedSpecialRules.version !== 1 ||
  !Array.isArray(parsedSpecialRules.rules) ||
  !parsedSpecialRules.rules.every(isSpecialRule)
) {
  throw new Error("predefined reply special rules are invalid");
}
const DIRECT_SPECIAL_RULES: readonly SpecialRule[] =
  parsedSpecialRules.rules;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const INDIRECT_OR_METALINGUISTIC = [
  /(?:と|って).{0,24}(?:言われ|言った|言って|言う|いう|聞いた|聞いて|呼ばれ|書いた)/iu,
  /という.{0,16}(?:曲|歌|映画|本|作品|タイトル|言葉|表現|意味)/iu,
  /\b(?:said|told|called|heard|quoted|wrote)\b/iu,
  /\b(?:is|was|means?|refers? to)\s+(?:the\s+)?(?:title|name|word|phrase|expression)\b/iu,
];

const SHORT_SLANG_ADDRESSEES = [
  "everyone",
  "everybody",
  "all",
  "folks",
  "friends",
  "guys",
  "world",
  "bsky",
  "bluesky",
];

const matchesSpecialRule = (text: string, rule: SpecialRule): boolean => {
  if (rule.mode === "short-slang") {
    return rule.aliases.some((alias) => {
      const escaped = escapeRegExp(alias);
      const addressees = SHORT_SLANG_ADDRESSEES.join("|");
      return new RegExp(
        `^${escaped}(?:[\\p{P}\\p{S}\\s]*(?:${addressees})?[\\p{P}\\p{S}\\s]*)$`,
        "u",
      ).test(text);
    });
  }

  return rule.aliases.some((alias) => {
    const escaped = escapeRegExp(alias);
    return rule.positions.some((position) => {
      const source =
        position === "start"
          ? `^${escaped}(?=$|[^\\p{L}\\p{N}_])`
          : `(?:^|[^\\p{L}\\p{N}_])${escaped}[\\p{P}\\p{S}\\s]*$`;
      return new RegExp(source, "iu").test(text);
    });
  });
};

export function detectDirectSpecialLabel(text: string): SpecialLabel | null {
  const normalized = removeQuotedText(text.normalize("NFKC")).trim();
  if (
    !normalized ||
    INDIRECT_OR_METALINGUISTIC.some((pattern) => pattern.test(normalized))
  ) {
    return null;
  }
  const matches = new Set(
    DIRECT_SPECIAL_RULES.filter((rule) =>
      matchesSpecialRule(normalized, rule),
    ).map(({ label }) => label),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function classifyProductionPredefinedReply(
  input: { text: string; languageName: string },
  dependencies: Pick<
    ProductionPredefinedReplyDependencies,
    "classifyThreeWay" | "now"
  > = {},
): Promise<ProductionPredefinedReplyClassification> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  const finish = (
    result: Omit<ProductionPredefinedReplyClassification, "method" | "latencyMs">,
  ): ProductionPredefinedReplyClassification => ({
    method: "rules-ollama-three-way",
    ...result,
    latencyMs: Math.max(0, now() - startedAt),
  });
  const special = detectDirectSpecialLabel(input.text);
  if (special) {
    return finish({
      label: special,
      llmCalls: 0,
      specialRule: "direct",
    });
  }
  try {
    const classifyThreeWay =
      dependencies.classifyThreeWay ?? classifyPolarityOllama;
    return finish({
      label: await classifyThreeWay(input.text),
      llmCalls: 1,
      specialRule: null,
    });
  } catch (error) {
    return finish({
      label: "neutral",
      llmCalls: 1,
      specialRule: null,
      error: errorMessage(error),
    });
  }
}

export function parsePredefinedReplySelectorMode(
  value: string | undefined,
): PredefinedReplySelectorMode {
  const normalized = value?.trim() || "random";
  if (normalized === "random" || normalized === "llm") return normalized;
  throw new Error(
    `PREDEFINED_REPLY_SELECTOR must be random or llm; received ${JSON.stringify(value)}`,
  );
}

export function resolvePredefinedReplySelectorMode(
  env: {
    PREDEFINED_REPLY_SELECTOR?: string;
    BSKY_PREDEFINED_SELECTOR?: string;
  },
): PredefinedReplySelectorMode {
  return parsePredefinedReplySelectorMode(
    env.PREDEFINED_REPLY_SELECTOR ?? env.BSKY_PREDEFINED_SELECTOR,
  );
}

export const PREDEFINED_REPLY_SELECTOR_MODE =
  resolvePredefinedReplySelectorMode({
    PREDEFINED_REPLY_SELECTOR: process.env.PREDEFINED_REPLY_SELECTOR,
    BSKY_PREDEFINED_SELECTOR: process.env.BSKY_PREDEFINED_SELECTOR,
  });

const randomIndex = (length: number, random: () => number): number =>
  Math.min(length - 1, Math.floor(random() * length));

/** LLM が3値で判定したか。定型あいさつの規則で決まった分と、失敗して neutral に倒した分は除く。 */
export function isLlmPolarityClassification(
  classification: ProductionPredefinedReplyClassification,
): classification is ProductionPredefinedReplyClassification & { label: PolarityLabel } {
  return (
    classification.llmCalls === 1 &&
    classification.specialRule === null &&
    !classification.error &&
    (classification.label === "positive" ||
      classification.label === "neutral" ||
      classification.label === "negative")
  );
}

export async function createPredefinedReply(
  input: {
    text: string;
    languageName: string;
    displayName: string;
  },
  options: {
    surface: "bsky" | "nagi";
    selectorMode?: PredefinedReplySelectorMode;
  },
  dependencies: ProductionPredefinedReplyDependencies = {},
): Promise<string> {
  const classification = await (
    dependencies.classify ?? classifyProductionPredefinedReply
  )(input, dependencies);
  dependencies.onClassified?.(classification);
  const selectorMode =
    options.selectorMode ?? PREDEFINED_REPLY_SELECTOR_MODE;
  console.info("[INFO][predefinedReply] classified", {
    surface: options.surface,
    method: classification.method,
    label: classification.label,
    latencyMs: Math.round(classification.latencyMs),
    llmCalls: classification.llmCalls,
    specialRule: classification.specialRule,
    selectorMode,
    failure: classification.error ? "classification-error" : null,
  });

  const affirmationDependencies: PredefinedAffirmationDependencies = {
    classify: async () => classification.label,
  };
  if (selectorMode === "random") {
    const random = dependencies.random ?? Math.random;
    affirmationDependencies.select = async (templates) =>
      randomIndex(templates.length, random);
  }
  if (dependencies.translate) {
    affirmationDependencies.translate = dependencies.translate;
  }

  return (dependencies.affirm ?? predefinedAffirmation)(
    input,
    affirmationDependencies,
  );
}
