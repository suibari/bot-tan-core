import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import { SYSTEM_INSTRUCTION, TONE_RULES_JA } from "@bsky-affirmative-bot/shared-configs";

/** 自動分析（プロフィールの「botたんのひとこと」）の入力。 */
export interface NagiAnalysisInput {
  /** 対象ユーザーの表示名（プロンプトに載せる）。 */
  displayName: string;
  /** ユーザー自身の投稿本文（Bluesky 投稿 or Nagi 投稿）。 */
  posts: string[];
  /** ユーザーがいいね/リアクションした投稿本文（趣味・相性の参考。任意）。 */
  liked?: string[];
  /** サブスク会員なら高品質ティアを使う。 */
  isSubscriber?: boolean;
}

/**
 * 自動分析の結果。称号は生成しない（本文のみ / ja・en を1リクエストで取得）。
 *
 * analysis はプロフィールの長文＆意味検索の埋め込みソース、tagline と tags は名刺カード用。
 * 名刺は面積が限られるので、長文を切り詰めるのではなく専用の短文を同じリクエストで作らせる。
 */
export interface NagiAnalysisResult {
  analysisJa: string;
  analysisEn: string;
  /** 名刺に載せる紹介文（日本語・最大120文字）。 */
  taglineJa: string;
  /** taglineJa の英訳（最大240文字）。 */
  taglineEn: string;
  /** ユーザーを表すハッシュタグ3つ（`#` は含まない）。 */
  tagsJa: string[];
  /** tagsJa と同じ順・同じ意味の英語タグ3つ。 */
  tagsEn: string[];
}

export const NAGI_ANALYSIS_PROMPT_VERSION = "nagi-analysis-v3";

/** 名刺タグは3つちょうど。多すぎ/少なすぎはレイアウトが崩れるのでここで揃える。 */
const TAG_COUNT = 3;

/**
 * botたんとしてユーザーの性格分析（「ひとこと」）を生成する。
 * generateAnalyzeResult（Bluesky bot 用・1言語＋称号）とは別に、Nagi 用として
 * 日本語と英語の本文を **1回の構造化リクエスト** で得る（責務: 本文のみ、称号は扱わない）。
 * 共有ペルソナ SYSTEM_INSTRUCTION を systemInstruction に載せ、口調のぶれを防ぐ。
 */
export async function generateNagiAnalysis(
  input: NagiAnalysisInput,
): Promise<NagiAnalysisResult> {
  const prompt = PROMPT_NAGI_ANALYSIS(input);

  const response = await generateContentWithRetry({
    feature: "NAGI_ANALYSIS",
    contents: [prompt],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          analysisJa: {
            type: Type.STRING,
            description:
              "性格分析の本文（日本語・最大500文字・空行を含めない）。具体的なポストやいいね/リアクション内容に言及し、全肯定のスタンスで分析すること。**敬語は使わず、botたんの口調（〜だよ/〜だね）で書くこと。**",
          },
          analysisEn: {
            type: Type.STRING,
            description:
              "analysisJa と同じ意味・情報量の自然な英訳（最大1000文字・空行を含めない）。",
          },
          // tagline は名刺のデザインに合わせた現状の文体を維持する（口調ルールは意図的に当てない）。
          taglineJa: {
            type: Type.STRING,
            description:
              "名刺に載せる紹介文（日本語・80〜120文字・改行なし）。このユーザーを第三者に紹介する言い回しで、人となりが伝わる具体的な内容を書くこと。",
          },
          taglineEn: {
            type: Type.STRING,
            description:
              "taglineJa と同じ意味・情報量の自然な英訳（最大240文字・改行なし）。",
          },
          tagsJa: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            minItems: String(TAG_COUNT),
            maxItems: String(TAG_COUNT),
            description:
              "このユーザーを表すハッシュタグ3つ（日本語）。'#' や空白を含めず、各12文字以内の単語にすること。",
          },
          tagsEn: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            minItems: String(TAG_COUNT),
            maxItems: String(TAG_COUNT),
            description:
              "tagsJa と同じ順・同じ意味の英語タグ3つ。'#' や空白を含めず、各20文字以内にすること。",
          },
        },
        required: [
          "analysisJa",
          "analysisEn",
          "taglineJa",
          "taglineEn",
          "tagsJa",
          "tagsEn",
        ],
        propertyOrdering: [
          "analysisJa",
          "analysisEn",
          "taglineJa",
          "taglineEn",
          "tagsJa",
          "tagsEn",
        ],
      },
    },
  }, 3);

  try {
    const json = JSON.parse(response.text || "{}") as Partial<NagiAnalysisResult>;
    return {
      // 本文中の [...] は表示に不要な注記なので落とす。JSON 全体に対して
      // 掛けると配列リテラルまで壊れるため、パース後の文字列にだけ適用する。
      analysisJa: stripBrackets(json.analysisJa),
      analysisEn: stripBrackets(json.analysisEn),
      taglineJa: stripBrackets(json.taglineJa),
      taglineEn: stripBrackets(json.taglineEn),
      tagsJa: normalizeTags(json.tagsJa),
      tagsEn: normalizeTags(json.tagsEn),
    };
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateNagiAnalysis:",
      e,
    );
    // 本文だけでも拾えれば分析としては成立する（名刺側は欠損にフォールバックする）。
    return {
      analysisJa: response.text || "",
      analysisEn: "",
      taglineJa: "",
      taglineEn: "",
      tagsJa: [],
      tagsEn: [],
    };
  }
}

const stripBrackets = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\[.*?\]/gs, "").trim() : "";

/**
 * モデルが '#タグ' やスペース混じりで返すことがあるので、名刺に出せる形へ整える。
 * 3つに満たなければ足さない（空配列扱いにせず、あるぶんだけ出す）。
 */
const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.replace(/^[#＃]+/, "").replace(/\s+/g, "").trim())
    .filter((tag) => tag.length > 0)
    .slice(0, TAG_COUNT);
};

const PROMPT_NAGI_ANALYSIS = (input: NagiAnalysisInput) =>
  `ユーザ自身のポストと、ユーザがいいね/リアクションしたポストを基に、性格分析をしてください。
分析結果は日本語（analysisJa）と英語（analysisEn）の両方を出力してください。両者は同じ意味・情報量にしてください。
日本語は最大500文字、英語は最大1000文字。どちらも空の行は入れないでください。
分析は以下の要素に基づいて生成し、具体的なポスト内容やいいね/リアクション内容に言及してください。
* ポジティブなポストの割合
* どんな趣味を持っているか（ユーザのポストおよびいいね/リアクションから分析する）
* 相性の良さそうな人（いいね/リアクションから分析する）
* 心がけるといいこと
# 名刺用の出力
このユーザーの「名刺」に載せる項目も一緒に作ってください。
* taglineJa / taglineEn … このユーザーを第三者に紹介する紹介文。日本語は80〜120文字、英語は最大240文字。
  分析本文の丸ごとの要約ではなく、名刺に載せて読み応えのある紹介文にしてください。
  趣味や人柄が具体的に伝わる内容にし、改行は入れないでください。
* tagsJa / tagsEn … このユーザーを表すハッシュタグを **ちょうど3つ**。
  '#' や空白は含めず、単語だけにしてください。日本語は各12文字以内、英語は各20文字以内。
  tagsJa[i] と tagsEn[i] は同じ意味になるよう対応させてください。
# ルール
* 悪い内容は含まず、全肯定のスタンスで分析してください。
* ユーザがいいね/リアクションしたポストは、ユーザ自身のポストではありません。趣味の参考としてのみ参照してください。
* 称号は考えなくてよいです（本文のみ）。

# 口調
分析対象のポストがどんな文体でも、**analysisJa** は必ずbotたんの口調にしてください。
（taglineJa / tagsJa は名刺のデザインに合わせた現状の文体のままでよく、この口調ルールの対象外です。）
${TONE_RULES_JA}

以下がユーザ名およびポスト、いいね/リアクションしたポストです。
-----
ユーザ名: ${input.displayName}
ポスト内容: ${input.posts.join("\n") || ""}
ユーザがいいね/リアクションしたポスト: ${(input.liked ?? []).join("\n") || ""}
`;
