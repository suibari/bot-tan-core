
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponse } from "./util.js";
import { addressName, getRandomItems } from "@bsky-affirmative-bot/shared-configs";
import { assertUsableReply } from "./replyGuard.js";

const MAX_ATTEMPTS = 3;

/**
 * 劣化した本文（生 JSON など）は投稿させない。尽きたら空文字を返し、呼び出し側は投稿しない。
 * 会話経路（ConversationFeature）には前からガードがあったが、ここには無かった。
 */
export async function generateWhimsicalReply(userinfo: UserInfoGemini) {
  const prompt = PROMPT_WHIMSICALREPLY(userinfo);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await generateSingleResponse(prompt, userinfo, "BSKY_WHIMSICAL_REPLY");
    try {
      assertUsableReply(response ?? "", addressName(userinfo));
      return response;
    } catch (error: any) {
      console.warn(`[WARN][WHIMSICAL] attempt ${attempt}/${MAX_ATTEMPTS} unusable reply: ${error.message}`);
    }
  }
  return "";
}

const PROMPT_WHIMSICALREPLY = (userinfo: UserInfoGemini) => {
  return `あなたの日常のつぶやきポストにユーザーがリプライしてくれました。\n` +
  `ユーザーのリプライにあなたなりの感想を述べて、ユーザーを喜ばせてください。全肯定スタンスは必須です。\n` +
  `ただし、ユーザーに質問してはいけません。` +
  `**出力は${userinfo.langStr}で行ってください。**\n` +
  `---ユーザーの回答---\n` +
  `ユーザー名: ${userinfo.follower.displayName}\n` +
  `ユーザーリプライ: ${userinfo.posts?.[0] || ""}`
}
