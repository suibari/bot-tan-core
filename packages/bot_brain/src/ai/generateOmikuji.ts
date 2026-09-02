
import { UserInfoGemini, GeminiScore } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponse } from "./util.js";
import { getRandomItems } from "@bsky-affirmative-bot/shared-configs";

export async function generateOmikuji(userinfo: UserInfoGemini) {
  const response = await generateSingleResponse(await PROMPT_OMIKUJI(userinfo), undefined, "BSKY_OMIKUJI");

  

  return response ?? "";
}

const PROMPT_OMIKUJI = async (userinfo: UserInfoGemini) => {
  return (userinfo.langStr === "日本語") ?
    `今日は元旦です。ユーザに新年のあいさつをし、おみくじを出してください。` +
    `お祝いのルール:` +
    `* ユーザの名前を呼んであげること` +
    `* 記念日が2つ以上の場合、それぞれに言及すること` +
    `* 1年前のユーザのポストがある場合、その内容をもとに、1年のがんばりをねぎらうこと` +
    `* おみくじのタイトルの意味を解説すること。アニメの元ネタがある場合は解説する` +
    `* おみくじの内容(特によかった項目TOP3)を解説すること` +
    `* 文字数は600文字以下にすること` +
    `---以下、ユーザ情報---` +
    `* ユーザ名: ${userinfo.follower.displayName ?? ""}` +
    `* 記念日: ${userinfo.anniversary?.map(item => item.names.ja).join(", ")}` +
    `* 1年前のユーザのポスト: ${userinfo.lastYearPosts?.[0] ?? "なし"}` +
    `* おみくじの内容(タイトル): ${getRandomItems(omikujiName, 1)[0]}` +
    `* おみくじの内容(特によかった項目TOP3): ${getRandomItems(omikujiContents, 3)}` :
    `Today is an anniversary. Celebrate the user to the fullest!` +
    `**Please output in ${userinfo.langStr}**` +
    `Celebration Rules:` +
    `* Call the user name.` +
    `* If the anniversary is a common one (New Year's Day, New Year's Eve, etc.), briefly explain the origin of the anniversary.` +
    `* If there are two or more anniversaries, mention each one.` +
    `* If there are posts from the user from a year ago, use those posts to praise their efforts this year.` +
    `* Explain the meaning of the omikuji title.` +
    `* Explain the top 3 items of the omikuji content.` +
    `* Character count must be 600 characters or less.` +
    `---User Information Below---` +
    `* User Name: ${userinfo.follower.displayName ?? ""}` +
    `* Anniversary: ${userinfo.anniversary?.map(item => item.names.en).join(", ")}` +
    `* User Posts from a Year Ago: ${userinfo.lastYearPosts?.[0] ?? "None"}` +
    `* Omikuji Title: ${getRandomItems(omikujiName, 1)[0]}` +
    `* Omikuji Content: ${getRandomItems(omikujiContents, 3)}`
    ;
}

const omikujiName = [
  "オラオラ大吉",
  "俺の手が燃えて幸運をつかみ取る大吉",
  "ドドドドド大吉",
  "波動が高まる大吉",
  "ギアをさらに上げる大吉",
  "超サイヤ大吉",
  "木の葉に祝福されし大吉",
  "無限に広がる大吉の呼吸・壱ノ型",
  "名探偵のひらめき大吉",
  "グレンラガン級に突き抜ける大吉",
  "海賊王に俺はなる大吉",
  "王の資質が目覚める大吉",
  "奇跡も魔法もある大吉",
  "世界が君を選ぶ大吉",
  "今日も元気にいってらっしゃい大吉",
  "機体性能限界突破大吉",
  "錬成成功大吉",
  "絶対運命大吉",
  "ラブ＆ピース大吉",
  "寄り添う精霊たちの大吉",
  "絶好調の波動大吉",
  "よみがえれオーバーソウル大吉",
  "真の仲間に恵まれる大吉",
  "ここから先は大吉領域だ",
  "奇跡の力が味方する大吉",
  "魔力量MAX大吉",
  "戦闘力たったの大吉？…いや超強い！",
  "天元突破大吉",
  "最終形態大吉",
  "ひらめきスパーク大吉",
  "ご注文は大吉ですか？",
  "とても良い大吉にゃ",
  "勇者覚醒大吉",
  "我が生涯に一片の悔いなし大吉",
  "黄金の風が吹く大吉",
  "宇宙で一番平和な大吉",
  "タマシイが震える大吉",
  "選ばれし子の大吉",
  "プリティー大吉",
  "プリンセスブレイブ大吉",
  "不死鳥のごとく舞い上がる大吉",
  "最高の相棒と出会う大吉",
  "よきかな大吉",
  "勇気100%大吉",
  "炎の意志が灯る大吉",
  "デュエル開始ィー大吉",
  "未来を変える大吉",
  "召喚成功大吉",
  "祝福されし青き炎の大吉",
  "命を吹き込む大吉",
  "俺は負けない大吉",
  "あなたに幸運を届けにきたよ大吉",
  "超究武神大吉",
  "伝説の勇者級大吉",
  "つらぬけ俺の大吉",
  "穏やかな心で放つ大吉",
  "誰にも邪魔させない大吉",
  "最強の主人公補正大吉",
  "スーパー平和大吉",
  "ギアスの力が働く大吉",
  "神さえ味方する大吉",
  "ひまわりのような大吉",
  "国を統べる王の大吉",
  "放課後大吉クラブ",
  "笑顔咲く大吉",
  "伝説始まる大吉",
  "ミラクルキャッチ大吉",
  "勇者部活動大吉",
  "祝福の大吉エール",
  "紅蓮の大吉スピリット",
  "さあ大吉の時間だ",
  "スーパーにっこにこ大吉",
  "そなたは美しい大吉",
  "最強剣士の大吉",
  "魂が叫ぶ大吉",
  "騎士の誓い大吉",
  "獅子の心臓大吉",
  "わたしの戦場はここじゃない大吉",
  "この世は大吉でできている",
  "ありえんほど強運大吉",
  "ホシの導き大吉",
  "友情・努力・大吉",
  "世界を救う大吉",
  "蒼き風が運ぶ大吉",
  "英雄の証明大吉",
  "超銀河大吉団",
  "奇跡の再会大吉",
  "信じる心が力になる大吉",
  "幸せゲージ満タン大吉",
  "すべてを癒す大吉",
  "今日も世界が平和です大吉",
  "大吉って いいよね",
  "愛と勇気の大吉",
  "主役の座はあなたです大吉",
  "光の翼ひろげる大吉",
  "ビジュいいじゃん大吉",
  "舞い降りる剣の大吉"
];

const omikujiContents = [
  "願望：自分の願い事が叶うかどうか",
  "恋愛：片思い・両思いを含めた恋愛の行方",
  "待人：恋愛のみならず、自分の運命にとって重要な人物が現れるかどうか",
  "走人：自分のところから去る人がいるかどうか",
  "縁談：結婚に関する良縁があるかどうか",
  "商売：ビジネスに関する運勢",
  "失物：物に限らず、探しているものに出くわすかどうか",
  "住居：転居や新築に関する良縁があるかどうか",
  "旅立：遠出のみならず、近場の外出や旅行に関する運勢",
  "健康：病気や怪我があるかどうか。ある場合は、治癒までの期間について",
  "学問：試験や勉強の結果に関する運勢",
  "争事：裁判や試合といった、誰かと争ったり競ったりする事柄に関する運勢",
  "抱人：自分のところで雇っている人に関する運勢",
]
