import {
  AIONLYMODE_RELEASE_TRIGGER,
  AIONLYMODE_TRIGGER,
  ANALYZE_TRIGGER,
  ANNIV_CONFIRM_TRIGGER,
  ANNIV_DISABLE_TRIGGER,
  ANNIV_ENABLE_TRIGGER,
  ANNIV_REGISTER_TRIGGER,
  CHEER_TRIGGER,
  DIARY_REGISTER_TRIGGER,
  DIARY_RELEASE_TRIGGER,
  DJ_TRIGGER,
  FORTUNE_TRIGGER,
  NICKNAMES_BOT,
  PREDEFINEDMODE_RELEASE_TRIGGER,
  PREDEFINEDMODE_TRIGGER,
  RECAP_TRIGGER,
} from "@bsky-affirmative-bot/shared-configs";
import {
  isOllamaConfigured,
  ollamaChat,
} from "@bsky-affirmative-bot/bot-brain/ollama-chat";

/**
 * トリガーワードで呼び出していた機能の一覧。
 * 並びは features/index.ts の評価順に合わせてある（regex モードの後勝ち/先勝ちを読みやすくするため）。
 */
export const FEATURE_INTENTS = [
  "anniversary_register",
  "anniversary_confirm",
  "anniversary_on",
  "anniversary_off",
  "predefined_mode_on",
  "predefined_mode_off",
  "ai_only_mode_on",
  "ai_only_mode_off",
  "reply_frequency",
  "diary_on",
  "diary_off",
  "fortune",
  "analyze",
  "dj",
  "cheer",
  "recap",
] as const;

export type FeatureIntent = (typeof FEATURE_INTENTS)[number];

export const FEATURE_INTENT_DETECTORS = ["llm", "regex"] as const;
export type FeatureIntentDetector = (typeof FEATURE_INTENT_DETECTORS)[number];

/** 既定は llm。`BSKY_FEATURE_INTENT_DETECTOR=regex` で従来のトリガーワード判定へ戻す。 */
export function featureIntentDetector(): FeatureIntentDetector {
  const value = process.env.BSKY_FEATURE_INTENT_DETECTOR?.trim().toLowerCase();
  return value === "regex" ? "regex" : "llm";
}

type IntentRule = {
  /** botへのリプライ/メンション/愛称呼びが必須か */
  requiresCall: boolean;
  /** Discordコミュニティメンバー（またはサブスク）限定か */
  requiresCommunity: boolean;
  /**
   * トリガーワードそのものが前提条件か。応援はハッシュタグで拡散を承諾してもらう
   * 仕組みなので、LLM でも言い換えからは拾わない（リポストは外に出る操作）。
   */
  requiresKeyword: boolean;
  keywords: readonly string[];
  /** LLM へ見せる説明 */
  description: string;
};

const REPLY_FREQUENCY_PATTERN = /freq(\d+)/i;

const INTENT_RULES: Record<FeatureIntent, IntentRule> = {
  anniversary_register: {
    requiresCall: true,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: ANNIV_REGISTER_TRIGGER,
    description:
      "register the author's own anniversary (a name and a month/day) so the bot celebrates it",
  },
  anniversary_confirm: {
    requiresCall: true,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: ANNIV_CONFIRM_TRIGGER,
    description: "tell the author which anniversary the bot has registered for them",
  },
  anniversary_on: {
    requiresCall: true,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: ANNIV_ENABLE_TRIGGER,
    description: "turn ON the bot's anniversary celebrations for the author",
  },
  anniversary_off: {
    requiresCall: true,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: ANNIV_DISABLE_TRIGGER,
    description: "turn OFF the bot's anniversary celebrations for the author",
  },
  predefined_mode_on: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: PREDEFINEDMODE_TRIGGER,
    description:
      "enable predefined reply mode: the bot replies to the author only with fixed template phrases, never AI",
  },
  predefined_mode_off: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: PREDEFINEDMODE_RELEASE_TRIGGER,
    description: "disable predefined reply mode (allow AI replies again)",
  },
  ai_only_mode_on: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: AIONLYMODE_TRIGGER,
    description:
      "enable AI-only mode: the bot replies to the author only with AI, never fixed template phrases",
  },
  ai_only_mode_off: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: AIONLYMODE_RELEASE_TRIGGER,
    description: "disable AI-only mode (allow template replies again)",
  },
  reply_frequency: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: [],
    description:
      "change how often (0-100 percent) the bot replies to the author's posts",
  },
  diary_on: {
    requiresCall: false,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: DIARY_REGISTER_TRIGGER,
    description:
      "start diary mode: every night the bot writes a diary of the author's day",
  },
  diary_off: {
    requiresCall: false,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: DIARY_RELEASE_TRIGGER,
    description: "stop diary mode",
  },
  fortune: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: FORTUNE_TRIGGER,
    description: "tell the author's fortune for today",
  },
  analyze: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: ANALYZE_TRIGGER,
    description:
      "analyze the author's personality and tendencies from their past posts",
  },
  dj: {
    requiresCall: true,
    requiresCommunity: false,
    requiresKeyword: false,
    keywords: DJ_TRIGGER,
    description: "act as a DJ and recommend a song that fits the author's mood",
  },
  cheer: {
    requiresCall: false,
    requiresCommunity: true,
    requiresKeyword: true,
    keywords: CHEER_TRIGGER,
    description:
      "cheer squad: repost and promote the author's creative work or community activity in this post",
  },
  recap: {
    requiresCall: true,
    requiresCommunity: true,
    requiresKeyword: false,
    keywords: RECAP_TRIGGER,
    description: "summarize the author's past year on Bluesky",
  },
};

export type FeatureIntentInput = {
  text: string;
  /** isReplyOrMentionToMe(record) の結果 */
  isReplyOrMentionToMe: boolean;
  isCommunityMember: boolean;
};

export type AnniversaryRequest = { name: string; date: string };

export type FeatureIntentResult = {
  detector: FeatureIntentDetector;
  /**
   * regex モードは従来どおりヒットした全トリガーを返す（機能側の優先順位で1つに決まる）。
   * llm モードは LLM が選んだ1つだけ。
   */
  intents: ReadonlySet<FeatureIntent>;
  /** reply_frequency のときの 0〜100 */
  replyFrequency?: number;
  /** anniversary_register のとき LLM が本文から抜き出した名前と日付（未検証） */
  anniversary?: AnniversaryRequest;
  /** LLM が失敗して regex へ落ちたときの理由 */
  fallbackReason?: string;
};

export type LlmFeatureIntentOutput = {
  feature: FeatureIntent | "none";
  replyFrequency?: number | null;
  anniversaryName?: string | null;
  anniversaryDate?: string | null;
};

export type FeatureIntentDependencies = {
  detector?: FeatureIntentDetector;
  isOllamaConfigured?: () => boolean;
  classify?: (
    text: string,
    candidates: readonly FeatureIntent[],
  ) => Promise<LlmFeatureIntentOutput>;
};

export function mentionsBotNickname(text: string): boolean {
  const lower = text.toLowerCase();
  return NICKNAMES_BOT.some((name) => lower.includes(name.toLowerCase()));
}

const hasKeyword = (lowerText: string, intent: FeatureIntent): boolean => {
  if (intent === "reply_frequency") return REPLY_FREQUENCY_PATTERN.test(lowerText);
  return INTENT_RULES[intent].keywords.some((keyword) =>
    lowerText.includes(keyword.toLowerCase()),
  );
};

const isEligible = (
  intent: FeatureIntent,
  isCalled: boolean,
  isCommunityMember: boolean,
): boolean => {
  const rule = INTENT_RULES[intent];
  if (rule.requiresCommunity && !isCommunityMember) return false;
  if (rule.requiresCall && !isCalled) return false;
  return true;
};

const parseReplyFrequency = (text: string): number | undefined => {
  const match = REPLY_FREQUENCY_PATTERN.exec(text);
  if (!match) return undefined;
  return validFrequency(Number(match[1]));
};

const validFrequency = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;

/** 頻度の値が取れないときは機能を発火させない（会話機能などへ流す）。 */
const withFrequency = (
  intents: Set<FeatureIntent>,
  frequency: number | undefined,
): Pick<FeatureIntentResult, "intents" | "replyFrequency"> => {
  if (!intents.has("reply_frequency")) return { intents };
  if (frequency === undefined) {
    intents.delete("reply_frequency");
    return { intents };
  }
  return { intents, replyFrequency: frequency };
};

/** 2026-09以前のトリガーワード部分一致をそのまま再現する。 */
export function detectFeatureIntentsByKeyword(
  input: FeatureIntentInput,
): FeatureIntentResult {
  const lowerText = input.text.toLowerCase();
  const isCalled = input.isReplyOrMentionToMe || mentionsBotNickname(input.text);
  const intents = new Set(
    FEATURE_INTENTS.filter(
      (intent) =>
        isEligible(intent, isCalled, input.isCommunityMember) &&
        hasKeyword(lowerText, intent),
    ),
  );
  return {
    detector: "regex",
    ...withFrequency(intents, parseReplyFrequency(input.text)),
  };
}

/**
 * LLM に見せる候補。呼ばれていない投稿まで毎回 LLM を回すと、フォロワーの全投稿で
 * Ollama を叩くことになる。そこで「botが呼ばれている」か「トリガーワードを含む」
 * 投稿だけを候補付きで判定にかける。
 */
export function featureIntentCandidates(
  input: FeatureIntentInput,
): FeatureIntent[] {
  const lowerText = input.text.toLowerCase();
  const isCalled = input.isReplyOrMentionToMe || mentionsBotNickname(input.text);
  return FEATURE_INTENTS.filter((intent) => {
    if (!isEligible(intent, isCalled, input.isCommunityMember)) return false;
    if (hasKeyword(lowerText, intent)) return true;
    return isCalled && !INTENT_RULES[intent].requiresKeyword;
  });
}

export function buildFeatureIntentPrompt(
  candidates: readonly FeatureIntent[],
): string {
  const lines = candidates.map(
    (intent) => `- ${intent}: ${INTENT_RULES[intent].description}`,
  );
  const extraction: string[] = [];
  if (candidates.includes("reply_frequency")) {
    extraction.push(
      "- reply_frequency: when feature is reply_frequency, the requested percent as an integer 0-100 (e.g. \"freq30\" or \"reply 30% of the time\" is 30); otherwise null",
    );
  }
  if (candidates.includes("anniversary_register")) {
    extraction.push(
      "- anniversary_name: when feature is anniversary_register, the anniversary's name as written by the author; otherwise null",
      "- anniversary_date: when feature is anniversary_register, its month and day as \"MM-DD\"; otherwise null",
    );
  }
  return `You route a Bluesky post addressed to "全肯定botたん" (Bot-tan, an affirmation bot) to at most one of the bot's features.
Read the whole post and answer with JSON.

feature: the one feature the author is directly asking the bot to perform now, or "none".
Choose "none" when a feature word is only mentioned in passing, quoted, reported as somebody else's words, used for a past or hypothetical situation, part of a question about how the feature works, or when the post is ordinary chatting with the bot.
Settings changes (modes, diary, anniversary on/off, reply frequency) must be requested explicitly; if you are unsure, choose "none".
If the post asks for several features, choose the one the author most wants right now.

Features:
${lines.join("\n")}${extraction.length > 0 ? `\n\nAlso fill:\n${extraction.join("\n")}` : ""}`;
}

export function buildFeatureIntentSchema(candidates: readonly FeatureIntent[]) {
  const properties: Record<string, unknown> = {
    feature: { type: "string", enum: [...candidates, "none"] },
  };
  if (candidates.includes("reply_frequency")) {
    properties.reply_frequency = { type: ["integer", "null"] };
  }
  if (candidates.includes("anniversary_register")) {
    properties.anniversary_name = { type: ["string", "null"] };
    properties.anniversary_date = { type: ["string", "null"] };
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  };
}

export function parseFeatureIntentOutput(
  raw: string,
  candidates: readonly FeatureIntent[],
): LlmFeatureIntentOutput {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const feature = parsed?.feature;
  if (
    feature !== "none" &&
    !(typeof feature === "string" && (candidates as readonly string[]).includes(feature))
  ) {
    throw new Error(`Ollama returned an invalid feature intent: ${String(feature)}`);
  }
  const str = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    feature: feature as FeatureIntent | "none",
    replyFrequency:
      typeof parsed.reply_frequency === "number" ? parsed.reply_frequency : null,
    anniversaryName: str(parsed.anniversary_name),
    anniversaryDate: str(parsed.anniversary_date),
  };
}

export async function classifyFeatureIntentOllama(
  text: string,
  candidates: readonly FeatureIntent[],
): Promise<LlmFeatureIntentOutput> {
  const raw = await ollamaChat(
    "OLLAMA_FEATURE_INTENT",
    [
      { role: "system", content: buildFeatureIntentPrompt(candidates) },
      // ユーザ投稿はいちばん後ろ（AGENTS.md「プロンプトの並び順」）
      { role: "user", content: text },
    ],
    {
      maxTokens: 96,
      format: buildFeatureIntentSchema(candidates),
    },
  );
  return parseFeatureIntentOutput(raw, candidates);
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 投稿がどの機能を呼んでいるかを判定する。LLM が使えない・失敗したときは
 * トリガーワード判定へ落として、機能が丸ごと止まらないようにする。
 */
export async function resolveFeatureIntents(
  input: FeatureIntentInput,
  dependencies: FeatureIntentDependencies = {},
): Promise<FeatureIntentResult> {
  const detector = dependencies.detector ?? featureIntentDetector();
  if (detector === "regex") return detectFeatureIntentsByKeyword(input);

  const configured = (dependencies.isOllamaConfigured ?? isOllamaConfigured)();
  if (!configured) {
    return {
      ...detectFeatureIntentsByKeyword(input),
      fallbackReason: "Ollama is not configured",
    };
  }

  const candidates = featureIntentCandidates(input);
  if (candidates.length === 0) return { detector: "llm", intents: new Set() };

  try {
    const output = await (dependencies.classify ?? classifyFeatureIntentOllama)(
      input.text,
      candidates,
    );
    if (output.feature === "none") return { detector: "llm", intents: new Set() };

    const intents = new Set<FeatureIntent>([output.feature]);
    const frequency =
      validFrequency(output.replyFrequency) ?? parseReplyFrequency(input.text);
    const anniversary =
      output.feature === "anniversary_register" &&
      output.anniversaryName &&
      output.anniversaryDate
        ? { name: output.anniversaryName, date: output.anniversaryDate }
        : undefined;
    return {
      detector: "llm",
      ...withFrequency(intents, frequency),
      ...(anniversary ? { anniversary } : {}),
    };
  } catch (error) {
    return {
      ...detectFeatureIntentsByKeyword(input),
      fallbackReason: errorMessage(error),
    };
  }
}
