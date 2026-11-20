
import { formatBotContext, generateContentWithRetry } from "./util.js";
import { SYSTEM_INSTRUCTION } from "@bsky-affirmative-bot/shared-configs";
import type { BotContext } from "@bsky-affirmative-bot/shared-configs";
import { Type } from "@google/genai";
import { pickQuestionTheme } from "./questionThemes.js";

/** recentThemes は直近に出したテーマ（新しい順）。同じ問いとカテゴリが続かないように避ける。 */
export async function generateQuestion(
  botContext?: BotContext,
  options: { recentThemes?: readonly string[]; now?: Date } = {},
) {
  const theme = pickQuestionTheme({ recentThemes: options.recentThemes, now: options.now }).text;
  const prompt = PROMPT_QUESTION(theme, botContext);
  const response = await generateContentWithRetry({
    feature: "BIORHYTHM_QUESTION",
    contents: [prompt],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          textJa: { type: Type.STRING },
          textEn: { type: Type.STRING },
        },
        required: ["textJa", "textEn"],
      },
    },
  });
  const result = JSON.parse(response.text || "{}") as { textJa?: string; textEn?: string };

  return {
    textJa: result.textJa ?? "",
    textEn: result.textEn ?? "",
    theme,
  }
} 

// botContext は定期ポスト側から明示的に渡す。generateContentWithRetry の userinfo 経由の
// 自動連結は使えない（UserInfoGemini は follower 必須で、定期ポストには相手がいない）。
export const PROMPT_QUESTION = (questionTheme: string, botContext?: BotContext) => {
  return `朝の挨拶と、全肯定質問コーナーの時間です。\n` +
  `フォロワーに質問を投げかけてください。\n` +
  `今回の質問は「${questionTheme}」です。\n` +
  `この問いの意味を変えずに、フォロワーが1行で答えやすい言葉で投げかけてください。\n` +
  `質問に回答してくれたフォロワーには、あなたからリプライすることを伝えてください。\n` +
  `ルール:\n` +
  `* 同じ質問内容について、自然な日本語版をtextJa、自然な英語版をtextEnに出力してください。\n` +
  `* ハッシュタグは出力に含めないでください。` +
  formatBotContext(botContext, "日本語", { purpose: "scheduledPost" })
}
