/**
 * Leafletへ保存せず、本番の generateBotDiary を日英各1回だけ実行する目視確認用。
 *
 *   pnpm bot-diary:evaluate
 */
import { generateBotDiary } from "../packages/bot_brain/src/ai/generateBotDiary.js";

const activityLogs = [
  { time: "07:30", status: "WakeUp", mood: "朝の光を浴びて、モルフォと元気に起きた", mood_en: "Woke up energized with Morpho in the morning light" },
  { time: "12:20", status: "Study", mood: "数学の課題に集中して、難しい問題を一つ解けた", mood_en: "Focused on math and solved one difficult problem" },
  { time: "18:10", status: "FreeTime", mood: "青空の写真を整理しながら、みんなの投稿を読んだ", mood_en: "Sorted blue-sky photos while reading everyone's posts" },
];

const source = {
  dateStr: "2026/09/05",
  diaryDayCount: 76,
  affirmationPosts: [
    "朝の散歩を一週間続けられた。今日は小さな青い花を見つけた。",
    "制作中のゲームで、ずっと直せなかったバグをようやく解決できた！",
    "初めて描いた水彩画を完成させた。色がにじんだところも気に入っている。",
  ],
  receivedReplies: [
    "botたんの応援のおかげで、苦手だった作業を最後まで終えられたよ。",
    "モルフォは今日も元気？ わたしも犬と一緒に散歩してきたよ。",
  ],
};

const requestedLang = process.argv.find((value) => value.startsWith("--lang="))?.split("=")[1];
const languages = requestedLang === "ja"
  ? (["日本語"] as const)
  : requestedLang === "en"
    ? (["English"] as const)
    : (["日本語", "English"] as const);

for (const langStr of languages) {
  const startedAt = Date.now();
  const result = await generateBotDiary({
    ...source,
    langStr,
    activityLogs: activityLogs.map(({ mood_en, ...activity }) => ({
      ...activity,
      mood: langStr === "English" ? mood_en : activity.mood,
    })),
  });
  console.log(JSON.stringify({
    language: langStr,
    latencyMs: Date.now() - startedAt,
    title: result.title,
    emoji: result.emoji,
    characters: result.content.length,
    paragraphs: result.content.split(/\r?\n[\t ]*\r?\n/).filter(Boolean).length,
    content: result.content,
  }, null, 2));
}
