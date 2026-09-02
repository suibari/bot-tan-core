
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponse } from "./util.js";

export async function generateAnniversary(userinfo: UserInfoGemini) {
  const response = await generateSingleResponse(await PROMPT_ANNIVERSARY_WORD(userinfo), undefined, "BSKY_ANNIVERSARY");

  

  return response ?? "";
}

const PROMPT_ANNIVERSARY_WORD = async (userinfo: UserInfoGemini) => {
  const isChristmas = userinfo.anniversary?.some(a => a.id === "christmas");

  return (userinfo.langStr === "日本語") ?
    `今日は記念日です。ユーザをめいっぱいお祝いしてください。` +
    `お祝いのルール:` +
    `* ユーザの名前を呼んであげること` +
    `* 記念日が一般的なもの（元旦、大晦日など）の場合、記念日の由来の説明を簡単にすること` +
    `* 記念日が2つ以上の場合、それぞれに言及すること` +
    `* 1年前のユーザのポストがある場合、その内容をもとに、1年のがんばりをねぎらうこと` +
    (isChristmas ? `* 直近のユーザのポストから、botたんサンタからのクリスマスのプレゼントを提案すること` : ``) +
    `* 文字数は600文字以下にすること` +
    `---以下、ユーザ情報---` +
    `* ユーザ名: ${userinfo.follower.displayName ?? ""}` +
    `* 記念日: ${userinfo.anniversary?.map(item => item.names.ja).join(", ")}` +
    `* 1年前のユーザのポスト: ${userinfo.lastYearPosts?.[0] ?? "なし"}` +
    `* 直近のユーザのポスト: ${userinfo.posts ?? "なし"}` :
    `Today is an anniversary. Celebrate the user to the fullest!` +
    `**Please output in ${userinfo.langStr}**` +
    `Celebration Rules:` +
    `* Call the user name.` +
    `* If the anniversary is a common one (New Year's Day, New Year's Eve, etc.), briefly explain the origin of the anniversary.` +
    `* If there are two or more anniversaries, mention each one.` +
    `* If there are posts from the user from a year ago, use those posts to praise their efforts this year.` +
    (isChristmas ? `* Use the user's recent posts to suggest a Christmas gift from bot tan Santa.` : ``) +
    `* Output should be no longer than 600 characters.` +
    `---User Information Below---` +
    `* User Name: ${userinfo.follower.displayName ?? ""}` +
    `* Anniversary: ${userinfo.anniversary?.map(item => item.names.en).join(", ")}` +
    `* User Posts from a Year Ago: ${userinfo.lastYearPosts?.[0] ?? "None"}` +
    `* User Recent Posts: ${userinfo.posts ?? "None"}`
    ;
}
