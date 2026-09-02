
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponse } from "./util.js";

export async function generateCheerResult(userinfo: UserInfoGemini) {
  const prompt =
`ユーザがポストおよび添付画像を拡散したがっています。
以下を他のBlueskyユーザ向けに宣伝してあげてください。
* ユーザのポスト内容のいいところや見るべきポイント
* 画像のいいところや見るべきポイント
日本語と、それを訳した英語を並べて回答を生成してください。
悪い内容は含まず、全肯定のスタンスで宣伝してください。
ハッシュタグについては言及しないでください。
以下がユーザ名およびポストです。
-----
ユーザ名: ${userinfo.follower.displayName}
ポスト内容: ${userinfo.posts || ""}
`;

  const response = await generateSingleResponse(prompt, userinfo, "BSKY_CHEER_RESULT");

  // Geminiリクエスト数加算
  

  // AI出力のサニタイズ("-----"を含むときそれ以降の文字列を削除)
  const result = response?.split("-----")[0];

  // 末尾にハッシュタグを付与し返却
  const hashtag = userinfo.langStr === "日本語" ? " #全肯定応援団" : " #Bot-tanSquad";
  return result ? result + hashtag : "";
}
