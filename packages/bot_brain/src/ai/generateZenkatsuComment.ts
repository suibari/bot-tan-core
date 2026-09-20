import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import {
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
  type CardDefinition,
} from "@bsky-affirmative-bot/shared-configs";

/** ゼンカツ！の提出に付ける、botたんの総評の入力。 */
export interface NagiZenkatsuCommentInput {
  /** 提出した人の表示名。 */
  displayName: string;
  /** その日のお題。**架空のシチュエーション**であって、この人に起きた出来事ではない。 */
  themeJa: string;
  themeEn: string;
  /** 出した札。プレイヤーが置いた順のまま渡す。 */
  cards: CardDefinition[];
  /**
   * サーバ側で決定論的に計算済みの「読み」。
   * 量子化モデルに ATK 合計のような算術をさせないため、結論だけを日本語で渡す。
   */
  reading: string[];
}

export interface NagiZenkatsuCommentResult {
  commentJa: string;
  commentEn: string;
}

/**
 * v2: 日英のカード名を出力欄に合わせて保存前に揃える。
 *
 * 設計の詳細は docs/zenkatsu.md の6章。要点は「肯定の対象を取り違えさせないこと」で、
 * ここには**肯定対象になりうる主体が3つ**ある。
 */
export const NAGI_ZENKATSU_PROMPT_VERSION = "nagi-zenkatsu-v2";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** モデルがもう一方の言語の正式名を選んでも、保存前に提出カードの正式名へ揃える。 */
export function normalizeZenkatsuCommentCardNames(
  comment: NagiZenkatsuCommentResult,
  cards: CardDefinition[],
): NagiZenkatsuCommentResult {
  const replaceNames = (text: string, locale: "ja" | "en") => {
    const names = new Map<string, string>();
    for (const card of cards) {
      const source = locale === "ja" ? card.nameEn : card.nameJa;
      const target = locale === "ja" ? card.nameJa : card.nameEn;
      if (source && target && source !== target) names.set(source, target);
    }
    if (!names.size) return text;
    const alternatives = [...names.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|");
    // 英語名が普通の英単語の一部に出た場合は触らず、和文との接続は許す。
    const pattern = locale === "ja"
      ? new RegExp(`(?<![A-Za-z0-9])(?:${alternatives})(?![A-Za-z0-9])`, "g")
      : new RegExp(alternatives, "g");
    return text.replace(pattern, (name) => names.get(name) ?? name);
  };

  return {
    commentJa: replaceNames(comment.commentJa, "ja"),
    commentEn: replaceNames(comment.commentEn, "en"),
  };
}

/**
 * 答えの長さに返しの長さを合わせる。1枚で決めたなら短く、3枚で語ったなら関係を読む。
 * （カードコメントがレアリティで出し分けているのに対し、こちらは枚数で分ける）
 */
function commentFormat(cardCount: number) {
  return cardCount === 1
    ? {
        ja: "日本語・1〜2文・最大80文字・改行なし",
        en: "英語・1〜2文・最大160文字・改行なし",
      }
    : {
        ja: "日本語・2〜3文・最大140文字・改行なし",
        en: "英語・2〜3文・最大280文字・改行なし",
      };
}

/**
 * ゼンカツ！の提出に、botたんの総評を付ける。
 *
 * 口調は必ず共有ペルソナ SYSTEM_INSTRUCTION に載せる（独自の口調指定を書かない）。
 * ja/en を1リクエストで取るのは generateNagiCardComment と同じ方針。
 */
export async function generateZenkatsuComment(
  input: NagiZenkatsuCommentInput,
): Promise<NagiZenkatsuCommentResult> {
  const format = commentFormat(input.cards.length);
  const response = await generateContentWithRetry(
    {
      /*
       * NAGI_ZENKATSU は lite-standard。カードコメントと同じ理由で FLEX を使わない。
       * ユーザーは提出直後にこの総評を見に来るので、待ち時間がそのまま体験の質になる。
       * 呼び出しは1ユーザーにつき1日1回なので総量はごくわずか。
       */
      feature: "NAGI_ZENKATSU",
      contents: [buildZenkatsuCommentPrompt(input)],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            commentJa: {
              type: Type.STRING,
              description: `その人が出した札への、botたんとしての総評（${format.ja}）。**敬語は使わず、botたんの口調（〜だよ/〜だね）で書くこと。**`,
            },
            commentEn: {
              type: Type.STRING,
              description: `commentJa と同じ気持ちを伝える自然な英語（${format.en}）。直訳ではなく英語として自然な言い回しにすること。`,
            },
          },
          required: ["commentJa", "commentEn"],
          propertyOrdering: ["commentJa", "commentEn"],
        },
      },
    },
    3,
  );

  try {
    const json = JSON.parse(
      response.text || "{}",
    ) as NagiZenkatsuCommentResult;
    return normalizeZenkatsuCommentCardNames({
      commentJa: (json.commentJa || "").trim(),
      commentEn: (json.commentEn || "").trim(),
    }, input.cards);
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateZenkatsuComment:",
      e,
    );
    return normalizeZenkatsuCommentCardNames(
      { commentJa: (response.text || "").trim(), commentEn: "" },
      input.cards,
    );
  }
}

/**
 * プロンプト本文。
 *
 * **並び順は AGENTS.md の規則どおり、出した札をいちばん後ろに置く。** お題も読みラベルも
 * 指示側へ寄せる。ユーザーの入力より後ろに材料を積むと、26B でも主体と時制を取り違える。
 *
 * モデルは Gemma4-12b なので、散文の禁止事項だけでは足りない。構造で補強している:
 * - 主体取り違えの禁止を、冒頭とカードブロックの**直前**の二箇所に置く
 * - **フィールド名そのものにルールを載せる**（「札の説明文（この人がした行動ではありません）」）。
 *   ラベルは値の真隣にあるので、小さいモデルにいちばん確実に効く
 * - 同時に課すルールを絞る（増やしたくなったら、まず出力を見てから）
 */
export const buildZenkatsuCommentPrompt = (
  input: NagiZenkatsuCommentInput,
): string => {
  const format = commentFormat(input.cards.length);
  /*
   * **英語名も必ず渡す。** 日本語名しか渡さないと、commentEn を書くときにモデルが自力で
   * 訳すことになり、12B では別言語が混ざる（実測で「積みゲーの番人」が韓国語の
   * 「쌓기 Game Guardian」になった）。定義側が正式な英語名を持っているので、それを使わせる。
   */
  const cards = input.cards
    .map(
      (card, index) =>
        `${index + 1}枚目: ${card.nameJa}（英語名: ${card.nameEn}） / ${card.rarity} / ${card.attribute} / ${card.raceJa} / ATK${card.atk}・DEF${card.def}
        札の説明文（この人がした行動ではありません）: ${card.textJa}`,
    )
    .join("\n");

  return `あなたのアプリ「Nagi」には「ゼンカツ！」という遊びがあります。
毎日ひとつシチュエーションが出て、みんなが手持ちの全肯定カードで答えます。
いま ${input.displayName} さんが答えました。それを読んだあなた（botたん）の総評を書いてください。

# 最重要（ここを間違えないこと）
* お題は**架空のシチュエーション**です。この人に実際に起きた出来事ではありません。
  「大変だったね」「お疲れさま」と、実体験のように受け取ってはいけません。
* カードの説明文に書かれている行いを、**この人がやったわけではありません。**
  「洗濯物を干した者」を出しても、この人が洗濯をしたとは限りません。
* **あなたが肯定するのは「その状況に、この札を選んだ」という選択です。**
  なぜその札なのかを自分なりに読み解いて、その読みを本人に話してください。

# 出力するもの
* commentJa: ${format.ja}。
  **札に触れるときは、下に書いてある日本語名をそのまま使ってください。英語名を混ぜないこと。**
* commentEn: 同じ気持ちを伝える自然な${format.en}。直訳ではなく英語として自然に。
  **札に触れるときは、下に書いてある英語名をそのまま使ってください。自分で訳さないこと。**
  **commentEn は全体を英語だけで書いてください。日本語や他の言語を混ぜないこと。**

# ルール
* 「いい編成だね」「センスあるね」だけで終わる汎用コメントは禁止です。
  最低1枚は名前を挙げて、それがこの状況にどう効くのかを言ってください。
* ふざけた答えにはふざけて乗り、まじめな答えにはまじめに返してください。
  **外している・ずれている・惜しい、とは絶対に言わないこと。** ここに不正解はありません。
* 追い風に合っていないことを、欠点として指摘しないでください。
* カードの説明文をそのまま繰り返さないこと。説明文は札の紹介、あなたの総評は本人への言葉です。
* 名前を呼ぶときは「${input.displayName}」をそのまま使ってください。プレースホルダを出力しないこと。
* 改行を入れないでください。
* 説明文は文語調ですが、その文体には引きずられないこと。
${TONE_RULES_JA}

# 今日のお題（架空のシチュエーション。この人の身に起きたことではありません）
${input.themeJa}

# この答えの読み（計算済みです。そのまま使ってよく、数え直す必要はありません）
${input.reading.map((line) => `* ${line}`).join("\n")}

# ${input.displayName} さんが出した札（この人の**選択**です。札の説明文は、この人がした行動ではありません）
-----
${cards}
`;
};
