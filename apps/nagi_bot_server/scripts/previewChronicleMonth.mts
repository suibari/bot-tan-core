/**
 * 年表の月次ロールアップを、**何も書かずに**1回試す。
 *
 * 本番DBから抜いた日記 JSON を食わせて、Ollama が実際にどんな節目を選ぶかだけを見る。
 * DB にも PDS にも触らない（ジョブも積まない）ので、本番データで安全に味見できる。
 *
 *   pnpm --filter nagi-bot-server chronicle:preview -- --file=/path/to.json --month=2026-08
 */
import { readFileSync } from "node:fs";
import {
  CHRONICLE_NEWS_CANDIDATE_LIMIT,
  generateChronicleNews,
  buildChronicleMonthInstruction,
  buildChronicleMonthMaterial,
  chronicleMonthFits,
  generateChronicleMonth,
  type ChronicleMonthInput,
} from "@bsky-affirmative-bot/bot-brain";
import {
  estimateMessagesTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
  SYSTEM_INSTRUCTION,
} from "@bsky-affirmative-bot/shared-configs";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = arg("file");
const month = arg("month");
if (!file || !month) {
  console.error("usage: chronicle:preview --file=<json> --month=YYYY-MM");
  process.exit(1);
}

/**
 * --news モード: その月の「そのころ世の中では」を1件選ばせる。
 * 入力は [{month, title, date, reactions}] の配列（反応の多い順）。
 */
if (process.argv.includes("--news")) {
  const all = JSON.parse(readFileSync(file, "utf8")) as Array<{
    month: string;
    title: string;
    date: string;
    reactions: number;
  }>;
  const limit = Number(arg("limit") ?? CHRONICLE_NEWS_CANDIDATE_LIMIT);
  const candidates = all
    .filter((n) => n.month === month)
    .slice(0, limit)
    .map((n) => ({ title: n.title, date: n.date }));
  console.log(`--- ${month} / そのころ世の中では ---`);
  console.log(`候補 ${candidates.length}件（その月の全体 ${all.filter((n) => n.month === month).length}件から）`);
  const started = Date.now();
  const picked = await generateChronicleNews({ month, candidates });
  console.log(`生成 ${((Date.now() - started) / 1000).toFixed(1)}秒`);
  if (picked.index === undefined) console.log("（選ばれず）");
  else {
    console.log(`◆ ${picked.titleJa}`);
    console.log(`   / ${picked.titleEn}`);
    console.log(`   元記事[${picked.index}]: ${candidates[picked.index].title}`);
  }
  process.exit(0);
}

const data = JSON.parse(readFileSync(file, "utf8")) as {
  displayName: string;
  diaries: Array<{ date: string; titleJa: string | null; text: string; langs: unknown }>;
  news: Array<{ month: string; title: string; genre: string | null }>;
};

const diaries = data.diaries.filter((d) => d.date.startsWith(month));
if (!diaries.length) {
  console.error(`${month} の日記が無い`);
  process.exit(1);
}
const langs = [...diaries].reverse().find((d) => Array.isArray(d.langs) && d.langs.length)
  ?.langs as string[] | undefined;

const input: ChronicleMonthInput = {
  displayName: data.displayName || "あなた",
  month,
  japanese: !langs?.length || langs[0].startsWith("ja"),
  diaries: diaries.map((d) => ({
    date: d.date,
    ...(d.titleJa ? { titleJa: d.titleJa } : {}),
    text: d.text,
  })),
  news: data.news
    .filter((n) => n.month === month)
    .map((n) => ({ title: n.title, ...(n.genre ? { genre: n.genre } : {}) })),
};

const material = buildChronicleMonthMaterial(input);
const instruction = `${SYSTEM_INSTRUCTION}\n${buildChronicleMonthInstruction(input)}`;
const estimated = estimateMessagesTokens([
  { content: instruction },
  { content: material },
]);
const budget = ollamaPromptBudget({
  numCtx: ollamaTextContextLength(),
  outputTokens: 2048,
});
const originalChars = diaries.reduce((n, d) => n + d.text.length, 0);
const sentChars = material.length;

console.log(`--- ${month} / ${input.displayName} ---`);
console.log(`日記 ${diaries.length}件 / ニュース候補 ${input.news.length}件`);
console.log(`本文 ${originalChars}字 → 材料 ${sentChars}字（切り詰め ${originalChars - sentChars}字ぶん）`);
console.log(`見積 ${estimated} / 予算 ${budget} トークン（収まる: ${chronicleMonthFits(input)}）`);

const started = Date.now();
const result = await generateChronicleMonth(input);
console.log(`生成 ${((Date.now() - started) / 1000).toFixed(1)}秒`);
console.log();
for (const h of result.highlights) {
  console.log(`● ${h.date}  ${h.titleJa}`);
  console.log(`   ${h.detailJa}`);
  console.log(`   根拠(逐語): 「${h.evidence}」`);
}
if (!result.highlights.length) console.log("（節目なし — この月は0件）");
if (result.newsIndex !== undefined) {
  console.log();
  console.log(`◆ そのころ世の中では: ${result.newsTitleJa}`);
  console.log(`   元記事: ${input.news[result.newsIndex]?.title}`);
}
process.exit(0);
