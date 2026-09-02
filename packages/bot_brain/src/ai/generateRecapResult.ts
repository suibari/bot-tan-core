
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponse } from "./util.js";

export async function generateRecapResult(userinfo: UserInfoGemini) {
  const prompt = PROMPT_RECAP(userinfo);
  const response = await generateSingleResponse(prompt, userinfo, "BSKY_RECAP");

  // Geminiリクエスト数加算
  

  return response ?? "";
}

const PROMPT_RECAP = (userinfo: UserInfoGemini) => {
  return userinfo.langStr === "日本語" ?
    `ユーザの今年の振り返りをしてください。
振り返り結果は以下の要素に基づいて生成してください。
* ユーザの1月～12月の月ごとのポストの総括
* ユーザがよく使う言葉 (特徴的な名詞をピックアップすること)
* ユーザがよく絡む相手 (全員の名前を挙げること)
* 今年の総括から言える、来年の抱負
# ルール
* 悪い内容は含まず、全肯定のスタンスで振り返りしてください
* 出力する文字数は1000文字以内とします

以下がユーザ名およびポスト、いいねしたポストです。
-----
ユーザ名: ${userinfo.follower.displayName}
1月のポスト内容: ${userinfo.postOnMonth?.[0] || ""}
2月のポスト内容: ${userinfo.postOnMonth?.[1] || ""}
3月のポスト内容: ${userinfo.postOnMonth?.[2] || ""}
4月のポスト内容: ${userinfo.postOnMonth?.[3] || ""}
5月のポスト内容: ${userinfo.postOnMonth?.[4] || ""}
6月のポスト内容: ${userinfo.postOnMonth?.[5] || ""}
7月のポスト内容: ${userinfo.postOnMonth?.[6] || ""}
8月のポスト内容: ${userinfo.postOnMonth?.[7] || ""}
9月のポスト内容: ${userinfo.postOnMonth?.[8] || ""}
10月のポスト内容: ${userinfo.postOnMonth?.[9] || ""}
11月のポスト内容: ${userinfo.postOnMonth?.[10] || ""}
12月のポスト内容: ${userinfo.postOnMonth?.[11] || ""}
ユーザがよく使う言葉: ${userinfo.topWords || ""}
ユーザがよく絡む相手: ${userinfo.followersFriend?.flat().map(follower => follower.profile.displayName).join(", ") || ""}
` :
    `Please provide a year-in-review for the user.
Generate the review results based on the following elements:
* Summary of the user's posts this year
* Words the user frequently uses (mention the most characteristic words)
* People the user frequently interacts with (mention all of them)
* Resolutions for next year by summary of this year
# Rules
* Do not include negative content; analyze from a fully positive stance.
* The text should be 2000 characters or less.

Below are the user name, posts, and posts they liked.
-----
Username: ${userinfo.follower.displayName}
January Post: ${userinfo.postOnMonth?.[0] || ""}
February Post: ${userinfo.postOnMonth?.[1] || ""}
March Post: ${userinfo.postOnMonth?.[2] || ""}
April Post: ${userinfo.postOnMonth?.[3] || ""}
May Post: ${userinfo.postOnMonth?.[4] || ""}
June Post: ${userinfo.postOnMonth?.[5] || ""}
July Post: ${userinfo.postOnMonth?.[6] || ""}
August Post: ${userinfo.postOnMonth?.[7] || ""}
September Post: ${userinfo.postOnMonth?.[8] || ""}
October Post: ${userinfo.postOnMonth?.[9] || ""}
November post: ${userinfo.postOnMonth?.[10] || ""}
December post: ${userinfo.postOnMonth?.[11] || ""}
Words frequently used by the user: ${userinfo.topWords || ""}
People the user frequently interacts with: ${userinfo.followersFriend?.flat().map(follower => follower.profile.displayName).join(", ") || ""}
`};
