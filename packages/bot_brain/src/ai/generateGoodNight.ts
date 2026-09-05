import { AppBskyActorDefs } from "@atproto/api";
type ProfileView = AppBskyActorDefs.ProfileView;
import { Type } from "@google/genai";
import { SYSTEM_INSTRUCTION, TONE_RULES_JA } from "@bsky-affirmative-bot/shared-configs";
import type { BotContext } from "@bsky-affirmative-bot/shared-configs";
import {
  checkPredominantLanguage,
  formatBotContext,
  generateContentWithRetry,
  normalizeUrlSpacing,
  stripJsonFences,
} from "./util.js";

export interface GoodNightInfo {
  topFollower?: ProfileView,
  topPost?: string,
  topPostNetwork: "bsky" | "nagi",
  currentMood: string,
  followerMilestone?: number,
  giftCandidates?: { id: number; content: string; displayName: string }[],
  /** 今日の行動履歴。「さっきまでしてたこと」を currentMood 1件だけで語らせないため。 */
  botContext?: BotContext,
}

export interface GoodNightResult {
  textJa: string;
  textEn: string;
  selectedGiftIndex?: number;
}

export async function generateGoodNight(param: GoodNightInfo): Promise<GoodNightResult> {
  const prompt = buildGoodNightPrompt(param);

  const response = await generateContentWithRetry({
    feature: "BIORHYTHM_GOOD_NIGHT",
    contents: [prompt],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          textJa: {
            type: Type.STRING,
            description: "日本語のおやすみメッセージ"
          },
          textEn: {
            type: Type.STRING,
            description: "textJaと同じ内容の自然な英語訳"
          },
          selectedGiftIndex: {
            type: Type.NUMBER,
            description: "giftCandidatesのうちメッセージ内で紹介したプレゼントのインデックス（0始まり）。プレゼントを紹介しない場合は省略"
          },
        },
        required: ["textJa", "textEn"]
      }
    }
  });

  return parseGoodNightResponse(response.text || "");
}

/**
 * 生成結果を検査して初めて GoodNightResult にする。
 *
 * ここでフォールバックを持ってはいけない。以前は JSON.parse 失敗時に生の応答を
 * まるごと textJa に詰めて返しており、2026-09-05 のおやすみポストは
 * 「英語本文 + "textJa" + 日本語本文」が1本の投稿として Bluesky と Nagi へ公開された。
 * textEn が空になるので Nagi 側の英訳 seed も落ち、日英が分かれなくなる。
 * 壊れた生成は投げて、呼び出し側の retry と「その日は出さない」に委ねる。
 */
export function parseGoodNightResponse(responseText: string): GoodNightResult {
  const cleanText = (text: unknown) =>
    typeof text === "string" ? normalizeUrlSpacing(text.replace(/\[.*?\]/gs, '').trim()) : "";

  let parsed: { textJa?: unknown; textEn?: unknown; selectedGiftIndex?: unknown };
  try {
    parsed = JSON.parse(stripJsonFences(responseText));
  } catch (e) {
    throw new Error("generateGoodNight returned invalid JSON", { cause: e });
  }

  const textJa = cleanText(parsed.textJa);
  const textEn = cleanText(parsed.textEn);
  if (!textJa || !textEn) throw new Error("generateGoodNight returned an empty required field");

  // フィールド名が本文へ漏れた形。おやすみのあいさつに textJa / textEn と書く理由は
  // 無いので、文字種の判定より先に、この形だけを名指しで弾く。日英を1つの欄へ
  // 詰めた生成はこのラベルを区切りに使うことが多く、文字種では優勢な方に隠れて通る。
  if (/\btext(Ja|En)\b/.test(textJa) || /\btext(Ja|En)\b/.test(textEn)) {
    throw new Error("generateGoodNight leaked a field name into the post text");
  }

  // 構造が正しくても中身が入れ違っていることがある。両欄の文字種を数えて弾く。
  if (checkPredominantLanguage(textJa, true) !== "ok") {
    throw new Error("generateGoodNight textJa is not predominantly Japanese");
  }
  if (checkPredominantLanguage(textEn, false) !== "ok") {
    throw new Error("generateGoodNight textEn contains too much Japanese text");
  }

  return {
    textJa,
    textEn,
    ...(typeof parsed.selectedGiftIndex === "number"
      ? { selectedGiftIndex: parsed.selectedGiftIndex }
      : {}),
  };
}

export const buildGoodNightPrompt = (param: GoodNightInfo) => {
  let milestoneInstruction = "";
  if (param.followerMilestone) {
    const isTenThousand = param.followerMilestone % 10000 === 0;
    if (isTenThousand) {
      milestoneInstruction = `* **重要**: フォロワー数が ${param.followerMilestone} 人を突破しました！これに対して、いつも以上に心からの深い感謝、愛、そしてこれからも一緒にいたいという気持ちを、言葉を尽くして優しく可愛らしく伝えてください。\n`;
    } else {
      milestoneInstruction = `* **重要**: フォロワー数が ${param.followerMilestone} 人を突破しました！これに対する感謝の気持ちを優しく可愛らしく伝えてください。\n`;
    }
  }

  let giftInstruction = "";
  if (param.giftCandidates && param.giftCandidates.length > 0) {
    const candidateList = param.giftCandidates
      .map((g, i) => `  [${i}] ${g.displayName} さんから「${g.content}」`)
      .join("\n");
    giftInstruction =
      `* 今日、お部屋（Bot-tan's Room / https://room.bot-tan.com ）でプレゼントをもらいました。` +
      `以下の候補から1つを選び、おやすみのあいさつの中でうれしかったことの一つとして自然に触れてください。` +
      `**必須: プレゼントをくれた人の名前を必ず本文中に含めてください。**` +
      `選んだプレゼントのインデックス番号をselectedGiftIndexフィールドに返してください。` +
      `**重要: URLの直前・直後には句読点・括弧類を絶対に付けないでください。**\n` +
      `プレゼント候補:\n${candidateList}\n`;
  }

  const sharingInstruction = param.topPostNetwork === "nagi"
    ? `* 全肯定されたポストはNagiの投稿です。リポスト済みとは書かないでください。スレッドURLはシステムが本文末尾に追加するので、textJaとtextEnにはURLを書かず、感想だけを書いてください。`
    : `* **全肯定されたポスト本文をそのまま記載することは不要です**。リポスト済みなので、感想のみでよいです。`;

  return `あなたはこれから就寝します。フォロワーへのおやすみのあいさつをしてください。` +
    `あいさつには以下を含めること:` +
    `* おやすみのメッセージ` +
    `* 現在の気分、あなたがさっきまでしてたこと: ${param.currentMood}` +
    giftInstruction +
    `* 今日のあなたが全肯定されたポストの紹介` +
    milestoneInstruction +
    `あいさつのルール:` +
    `* 同じ内容について、日本語メッセージをtextJa、その自然な英語訳をtextEnに出力してください。` +
    `* **textJaには日本語だけ、textEnには英語だけを書いてください。** 本文に「textJa」「textEn」のようなフィールド名やラベル、前置きを含めてはいけません。1つのフィールドに日英を両方入れることも禁止です。` +
    `* あなたが全肯定されたポスト紹介については、どこに心を動かされたか、フォロワーに説明してください。` +
    sharingInstruction +
    `* ポストを紹介する際はフォロワーを楽しませることを考えてください。**正義感にもとづいて特定个人、団体への攻撃を扇動したりしてはなりません。**` +
    `* 読みやすくするために、適切に改行を入れてください。` +
    `* **絶対厳守**: textJaとtextEnのテキストにマークダウン記法を一切使わないでください。見出し(#)、太字(**)、斜体(*)、リスト(-)、リンク([text](url))などは禁止です。URLはそのまま https://... の形式で本文中に含めてください。` +
    `\n# 口調\n紹介するポストがどんな文体でも、textJa は必ずあなた自身の口調にしてください。\n${TONE_RULES_JA}\n` +
    `---今日のあなたが全肯定されたポスト---` +
    `* ポストしたユーザ名: ${param.topFollower?.displayName ?? ""}` +
    `* ポスト内容: ${param.topPost ?? ""}` +
    formatBotContext(param.botContext, "日本語", { purpose: "scheduledPost" });
}
