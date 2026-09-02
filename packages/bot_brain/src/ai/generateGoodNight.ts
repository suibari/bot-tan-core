import { AppBskyActorDefs } from "@atproto/api";
type ProfileView = AppBskyActorDefs.ProfileView;
import { Type } from "@google/genai";
import { SYSTEM_INSTRUCTION, TONE_RULES_JA } from "@bsky-affirmative-bot/shared-configs";
import type { BotContext } from "@bsky-affirmative-bot/shared-configs";
import { formatBotContext, generateContentWithRetry, normalizeUrlSpacing } from "./util.js";

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

  const responseText = response.text || "";
  const cleanText = (text: string) =>
    normalizeUrlSpacing((text || "").replace(/\[.*?\]/gs, '').trim());

  try {
    const parsed = JSON.parse(responseText) as { textJa: string; textEn: string; selectedGiftIndex?: number };
    return {
      textJa: cleanText(parsed.textJa),
      textEn: cleanText(parsed.textEn),
      selectedGiftIndex: parsed.selectedGiftIndex,
    };
  } catch (e) {
    console.error("[ERROR][GEMINI] Failed to parse generateGoodNight response JSON:", responseText, e);
    return { textJa: cleanText(responseText), textEn: "" };
  }
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
