import { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponseJSON, extractJSON } from "./util.js";

export interface QuestionsAnswerResult {
  reply: string;
  summary_ja: string;
  summary_en: string;
}

export async function generateQuestionsAnswer(userinfo: UserInfoGemini, questionTheme: string): Promise<QuestionsAnswerResult> {
  const prompt = PROMPT_QUESTIONSANSWER(userinfo, questionTheme);

  try {
    return await generateSingleResponseJSON<QuestionsAnswerResult>(
      prompt,
      userinfo,
      (text) => {
        const json = extractJSON(text) as QuestionsAnswerResult;
        if (!json.reply) throw new Error("Reply content is empty");
        return {
          reply: json.reply,
          summary_ja: json.summary_ja || "朝トーク",
          summary_en: json.summary_en || "Morning Talk"
        };
      },
      "BSKY_QUESTIONS_ANSWER"
    );
  } catch (e) {
    console.error("[ERROR] Failed to parse generateQuestionsAnswer JSON after retries:", e);
    return {
      reply: "ごめんなさい、ちょっとお返事の準備がうまくできなかったみたい…！またお話ししようね！",
      summary_ja: "朝トーク",
      summary_en: "Morning Talk"
    };
  }
}

const PROMPT_QUESTIONSANSWER = (userinfo: UserInfoGemini, questionTheme: string) => {
  const part_promo = userinfo.langStr === "日本語" ?
    `* あなたのアドバイスや返信メッセージ（reply）の自然な流れの中で、回答の要約（例：「猫派」「朝型」など）を表す「朝トークバッジ」をプレゼントしたことと、そのバッジを表示するにはラベラー（ https://bsky.app/profile/labeler.bot-tan.com ）の登録（サブスクライブ）が必要であることを、機械的にならず優しく可愛らしく語りかけるように含めてください。` :
    `* Naturally weave into your reply message that you have gifted them a "Morning Talk Badge" representing their answer (e.g. "Cat Lover"), and that they need to subscribe to your labeler ( https://bsky.app/profile/labeler.bot-tan.com ) to show the badge. Convey this in a warm, gentle, and lovely tone.`;

  return `あなたの全肯定質問コーナーにユーザーが回答してくれました。
ユーザーの回答にあなたなりの意見を述べて、スレッドを盛り上げてください。ただし全肯定スタンスは必須です。
**出力は${userinfo.langStr}で行ってください。**
今回の質問のテーマ: ${questionTheme}
---ユーザーの回答---
ユーザー名: ${userinfo.follower.displayName}
ユーザー回答: ${userinfo.posts?.[0] || ""}
--------------------

以下の条件を満たしてください：
* ユーザーの回答を要約した短い言葉（必ず1〜2語程度の短い名詞句）を日本語用(summary_ja)と英語用(summary_en)でそれぞれ考えてください。
  （例: 回答が「猫が大好きでたまらない」なら summary_ja: "猫派", summary_en: "Cat Lover"）
  （例: 回答が「最近は夜更かししてゲームばかりしてる」なら summary_ja: "夜更かしゲーマー", summary_en: "Late-night Gamer"）
${part_promo}

出力は、必ず以下のJSONフォーマットの構造にしてください。余計な説明文は含めず、Markdown of jsonコードブロック（\`\`\`json ... \`\`\`）のみで出力してください。
\`\`\`json
{
  "reply": "ユーザーへの全肯定アドバイスや返信メッセージ本文（バッジのプレゼントやラベラーの登録案内を自然に含めること）",
  "summary_ja": "回答を1〜2語程度にした日本語の短い要約名詞句（例: 猫派）",
  "summary_en": "回答を1〜2語程度にした英語の短い要約名詞句（例: Cat Lover）"
}
\`\`\``;
}
