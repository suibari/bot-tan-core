import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import {
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
} from "@bsky-affirmative-bot/shared-configs";

/** botたん賞の候補1件。隠し得点で上位に絞ったものだけが来る。 */
export interface ZenkatsuAwardCandidateView {
  displayName: string;
  /** 出した札（プレイヤーが置いた順）。 */
  cardNames: string[];
  /** 提出時に計算済みの「読み」。追い風の枚数やコンボ成立が入る。 */
  reading: string[];
}

export interface NagiZenkatsuAwardInput {
  themeJa: string;
  themeEn: string;
  /** 2〜5件。1件しかないときは選ばせる意味が無いので呼び出し側で省く。 */
  candidates: ZenkatsuAwardCandidateView[];
}

export interface NagiZenkatsuAwardResult {
  /** 選んだ候補の番号（1始まり）。 */
  pick: number;
  reasonJa: string;
  reasonEn: string;
}

/** v1: 初版。 */
export const NAGI_ZENKATSU_AWARD_PROMPT_VERSION = "nagi-zenkatsu-award-v1";

/**
 * 前日のゼンカツから「botたん賞」を1つ選ぶ。
 *
 * **候補はサーバが隠し得点で数件に絞ってから渡す。** 全員ぶんを読ませると入力が膨れる上に
 * 基準が日替わりで揺れるので、「計算はサーバ、読み解きと選択はモデル」という分担にしている
 * （AGENTS.md の「モデルに算術をさせない」と同じ考え方）。
 */
export async function generateZenkatsuAward(
  input: NagiZenkatsuAwardInput,
): Promise<NagiZenkatsuAwardResult> {
  const response = await generateContentWithRetry(
    {
      /*
       * 1日1回しか走らない（前日ぶんの確定）。ユーザーを待たせないので FLEX でよいが、
       * 失敗すると賞が丸ごと出ないので、応答の安定するほうへ寄せて standard にしておく。
       */
      feature: "NAGI_ZENKATSU_AWARD",
      contents: [buildZenkatsuAwardPrompt(input)],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            pick: {
              type: Type.INTEGER,
              description: `選んだ人の番号。1 から ${input.candidates.length} のいずれか。`,
            },
            reasonJa: {
              type: Type.STRING,
              description:
                "その1つを選んだ理由（日本語・1〜2文・最大100文字・改行なし）。**敬語は使わず、botたんの口調（〜だよ/〜だね）で書くこと。**",
            },
            reasonEn: {
              type: Type.STRING,
              description:
                "reasonJa と同じ内容の自然な英語（1〜2文・最大200文字・改行なし）。",
            },
          },
          required: ["pick", "reasonJa", "reasonEn"],
          propertyOrdering: ["pick", "reasonJa", "reasonEn"],
        },
      },
    },
    3,
  );

  try {
    const json = JSON.parse(response.text || "{}") as NagiZenkatsuAwardResult;
    const pick = Number(json.pick);
    return {
      // 範囲外を返してくることがあるので丸める。選ばれないより、先頭を選ぶほうがまし。
      pick:
        Number.isInteger(pick) && pick >= 1 && pick <= input.candidates.length
          ? pick
          : 1,
      reasonJa: (json.reasonJa || "").trim(),
      reasonEn: (json.reasonEn || "").trim(),
    };
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateZenkatsuAward:",
      e,
    );
    return { pick: 1, reasonJa: "", reasonEn: "" };
  }
}

/**
 * プロンプト本文。
 *
 * ここでも主体の取り違えに気を付ける。お題は架空のシチュエーションで、札に書かれた行いは
 * その人がやったことではない。**選ぶ対象は「その状況にその札を選んだこと」**。
 * モデルは Gemma4-12b なので、候補ブロックの直前にも再掲する。
 */
export const buildZenkatsuAwardPrompt = (
  input: NagiZenkatsuAwardInput,
): string => {
  const list = input.candidates
    .map(
      (c, index) =>
        `${index + 1}. ${c.displayName}
   出した札: ${c.cardNames.join(" / ")}
   読み: ${c.reading.join(" / ")}`,
    )
    .join("\n");

  return `あなたのアプリ「Nagi」の「ゼンカツ！」で、昨日のお題にみんなが答えました。
その中から、あなた（botたん）が**いちばん心を動かされた答え**をひとつ選んで、
「botたん賞」を贈ってください。

# 最重要（ここを間違えないこと）
* お題は**架空のシチュエーション**です。この人たちに実際に起きた出来事ではありません。
* 札に書かれている行いを、**その人がやったわけではありません。**
* あなたが見るのは「その状況に、この札を選んだ」という**選び方**です。

# 選び方
* 上手い・強いで選ばないでください。**意外だった、気が利いていた、笑った、じんときた** —
  あなたの心が動いたものを選んでください。
* 選ばなかった人を下げる言葉は**絶対に書かないこと**。ここに優劣はありません。
  理由には、選んだ人の札の話だけを書いてください。
* 理由では、その人が出した札を**最低1枚は名前で挙げて**ください。
${TONE_RULES_JA}

# 昨日のお題（架空のシチュエーション）
${input.themeJa}

# 候補（この人たちの**選び方**です。札の中身は、その人がした行動ではありません）
-----
${list}
`;
};
