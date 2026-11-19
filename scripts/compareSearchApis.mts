/**
 * SearXNG（Yahoo）の代わりにする Web 検索 API の比較。
 *
 * 2026-11-14 から自宅回線の IPv4 / IPv6 とも Yahoo に汚染され、スクレイピング型の
 * SearXNG では知識カードの材料が取れなくなった。有料 API のどれに移るかを、
 * 知識カードで実際に間違えた語（reply-grounding の probe-bing-only の27語）で比べる。
 *
 * 1語につき2通り投げる。
 *   - bare: 語だけ。曖昧な語を正しいジャンルへ寄せられるか（「トリシューラ」→ シヴァ神の槍 ではなく遊戯王）
 *   - ctx:  本番と同じ `${term} ${keyword}`。その物自体のページが上位に来るか
 * 判定は上位3件のタイトル・本文・URL。bare はジャンル語、ctx は語そのものが含まれるか。
 * 機械判定は粗いので、出力の上位3件のタイトルを目でも確かめること。
 *
 * 使い方:
 *   pnpm search-api:compare
 *   pnpm search-api:compare -- --providers=serper,brave --out=docs/evaluations/search-api/summary.md
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Hit = { title: string; url: string; content: string };
type Provider = {
  name: string;
  key: string | undefined;
  /** 連続で投げるときの間隔。無料枠の QPS に合わせる。 */
  gapMs: number;
  search: (query: string, key: string) => Promise<Hit[]>;
};

type Case = { term: string; keyword: string; genre: string[] };

const YGO = ["遊戯王", "yu-gi-oh", "yugioh", "ocg", "デュエル"];

/** probe-bing-only（2026-11-06）の27語に、関連性監視の3語と 11/19 の取りこぼしを足したもの。 */
const CASES: Case[] = [
  ...[
    "ラー玉", "ニビル", "スカノヴァ", "マスターデュエル", "ラーの翼神竜", "KCカップ",
    "ゴッド・ブレイズ・キャノン", "死者蘇生", "トリシューラ", "氷水", "スキルドレイン",
    "ポルターガイスト", "ショックルーラー", "ライディングデュエル", "シャイニング・ネオス・ウィングマン",
    "リゾネーター", "古の呪文", "ゴッドスライム", "壊獣", "グレイドル", "ギャラクシーアイズ",
    "BF－アーマード・ウィング", "カードガンナー",
  ].map((term) => ({ term, keyword: "遊戯王", genre: YGO })),
  { term: "デュエプレ", keyword: "デュエル・マスターズ", genre: ["デュエル・マスターズ", "デュエマ", "duel masters"] },
  { term: "メイドインアビス 目覚める神秘", keyword: "ゲーム", genre: ["メイドインアビス", "made in abyss"] },
  { term: "Anki", keyword: "暗記カード", genre: ["暗記", "flashcard", "ankiweb", "フラッシュカード"] },
  { term: "MOSS-image", keyword: "画像生成", genre: ["画像", "image"] },
  { term: "葬送のフリーレン", keyword: "アニメ", genre: ["フリーレン", "frieren"] },
  { term: "超融合", keyword: "遊戯王", genre: YGO },
  { term: "Puella Magi Madoka Magica", keyword: "anime", genre: ["madoka", "まどか"] },
  { term: "Bridget", keyword: "ギルティギア", genre: ["guilty gear", "ギルティギア", "ギルティ"] },
  { term: "テト", keyword: "重音テト", genre: ["重音", "utau", "kasane"] },
];

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s・\-－‐_]/g, "");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
}

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function topContains(hits: Hit[], words: string[]): boolean {
  const expected = words.map(normalize);
  return hits.slice(0, 3).some((hit) => {
    const text = normalize(`${hit.title} ${hit.content} ${safeDecode(hit.url)}`);
    return expected.some((word) => text.includes(word));
  });
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const PROVIDERS: Provider[] = [
  {
    name: "serper",
    key: process.env.SERPER_API_KEY,
    gapMs: 300,
    async search(query, key) {
      const data = await postJson("https://google.serper.dev/search", { "X-API-KEY": key }, {
        q: query, gl: "jp", hl: "ja", num: 10,
      });
      return (data.organic ?? []).map((item: any) => ({
        title: item.title ?? "", url: item.link ?? "", content: item.snippet ?? "",
      }));
    },
  },
  {
    name: "brave",
    key: process.env.BRAVE_API_KEY,
    gapMs: 1_100,
    async search(query, key) {
      // Brave の日本語は search_lang=jp（ISO の ja ではない）。
      const params = new URLSearchParams({ q: query, country: "JP", search_lang: "jp", count: "10" });
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data: any = await response.json();
      return (data.web?.results ?? []).map((item: any) => ({
        title: stripTags(item.title ?? ""), url: item.url ?? "", content: stripTags(item.description ?? ""),
      }));
    },
  },
  {
    name: "exa",
    key: process.env.EXA_API_KEY,
    gapMs: 300,
    async search(query, key) {
      const data = await postJson("https://api.exa.ai/search", { "x-api-key": key }, {
        query, type: "auto", numResults: 10, contents: { text: { maxCharacters: 300 } },
      });
      return (data.results ?? []).map((item: any) => ({
        title: item.title ?? "", url: item.url ?? "", content: item.text ?? "",
      }));
    },
  },
  {
    // 無料枠でいちばん回数が取れる型（$4/1000）。auto（$7/1000）との質の差を見る。
    name: "exa-lite",
    key: process.env.EXA_API_KEY,
    gapMs: 300,
    async search(query, key) {
      const data = await postJson("https://api.exa.ai/search", { "x-api-key": key }, {
        query, type: "lite", numResults: 10, contents: { text: { maxCharacters: 300 } },
      });
      return (data.results ?? []).map((item: any) => ({
        title: item.title ?? "", url: item.url ?? "", content: item.text ?? "",
      }));
    },
  },
  {
    name: "tavily",
    // .env では TRAVILY_API_KEY の綴りで入っている。
    key: process.env.TAVILY_API_KEY ?? process.env.TRAVILY_API_KEY,
    gapMs: 300,
    async search(query, key) {
      const data = await postJson("https://api.tavily.com/search", { Authorization: `Bearer ${key}` }, {
        query, search_depth: "basic", max_results: 10, country: "japan",
      });
      return (data.results ?? []).map((item: any) => ({
        title: item.title ?? "", url: item.url ?? "", content: item.content ?? "",
      }));
    },
  },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const wanted = flag("providers")?.split(",");
const outPath = flag("out") ?? "docs/evaluations/search-api/summary.md";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Row = { query: string; mode: "bare" | "ctx"; pass: boolean | null; ms: number; top: string[]; error?: string };

async function runProvider(provider: Provider): Promise<Row[]> {
  const rows: Row[] = [];
  for (const item of CASES) {
    for (const mode of ["bare", "ctx"] as const) {
      const query = mode === "bare" ? item.term : `${item.term} ${item.keyword}`;
      const started = Date.now();
      try {
        const hits = await provider.search(query, provider.key!);
        const pass = mode === "bare" ? topContains(hits, item.genre) : topContains(hits, [item.term]);
        rows.push({ query, mode, pass, ms: Date.now() - started, top: hits.slice(0, 3).map((hit) => hit.title.slice(0, 50)) });
      } catch (error) {
        rows.push({ query, mode, pass: null, ms: Date.now() - started, top: [], error: (error as Error).message.slice(0, 120) });
      }
      process.stdout.write(rows.at(-1)!.pass === null ? "E" : rows.at(-1)!.pass ? "." : "x");
      await sleep(provider.gapMs);
    }
  }
  process.stdout.write("\n");
  return rows;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

const active = PROVIDERS.filter((provider) => (!wanted || wanted.includes(provider.name)) && provider.key);
for (const provider of PROVIDERS) {
  if (!provider.key && (!wanted || wanted.includes(provider.name))) console.warn(`[skip] ${provider.name}: API キーなし`);
}

const results = await Promise.all(active.map(async (provider) => {
  const rows = await runProvider(provider);
  console.log(`${provider.name} done`);
  return { provider, rows };
}));

const lines: string[] = [
  "# 検索 API の比較",
  "",
  `updated: ${new Date().toISOString()}`,
  "",
  "bare = 語だけでジャンル語が上位3件に出たか / ctx = `語 + 文脈語` で語そのものが上位3件に出たか",
  "",
  "| API | bare | ctx | エラー | 応答時間の中央値 |",
  "|---|---|---|---|---|",
];
for (const { provider, rows } of results) {
  const score = (mode: "bare" | "ctx") => {
    const judged = rows.filter((row) => row.mode === mode && row.pass !== null);
    return `${judged.filter((row) => row.pass).length}/${judged.length}`;
  };
  const errors = rows.filter((row) => row.pass === null).length;
  lines.push(`| ${provider.name} | ${score("bare")} | ${score("ctx")} | ${errors} | ${median(rows.map((row) => row.ms))}ms |`);
}
for (const { provider, rows } of results) {
  lines.push("", `## ${provider.name}`, "", "| クエリ | 判定 | 上位3件 |", "|---|---|---|");
  for (const row of rows) {
    const mark = row.pass === null ? "E" : row.pass ? "○" : "✗";
    const top = row.error ? `エラー: ${row.error}` : row.top.join(" / ") || "0件";
    lines.push(`| ${row.query} | ${mark} | ${top.replace(/\|/g, "｜")} |`);
  }
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${lines.join("\n")}\n`);
console.log(lines.slice(0, 7 + results.length + 1).join("\n"));
console.log(`\n→ ${outPath}`);
