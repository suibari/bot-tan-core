/**
 * Step 0 のゲート。SearXNG が Gemini grounding の代わりになるか実測する。
 *
 * grounding の調査段を Gemini から自前の SearXNG へ移す前に、**日本語で実在する
 * 固有名詞が拾えるか**を先に確かめる。ここが通らなければ実装に進んではいけない。
 * `BIORHYTHM_SEASONAL_WORKS` は policy `required` で、調査失敗が throw になるため。
 *
 * 使い方:
 *   pnpm searxng:probe                 # 検索のみ（速い）
 *   pnpm searxng:probe -- --fetch      # 上位結果の本文取得まで含める（本番同等）
 *   pnpm searxng:probe -- --query="任意のクエリ"      # 複数指定できる
 *   pnpm searxng:probe -- --engines=wikipedia        # エンジンを絞って効き目を比べる
 *
 * 【実測メモ】トピック語を先頭に、年を末尾に置くこと。年を先頭に置くと Bing が
 * それを主要語と解釈し、「2026年カレンダー」の配布サイトばかりを返す。
 *   "夏アニメ 2026" / "夏ドラマ 2026" / "新作ゲーム 2026" → 正しい一覧が並ぶ
 *   "2026年 夏ドラマ" / "2026年 新作ゲーム"               → 全部カレンダー
 * また wikipedia / wikidata は results ではなく infobox を返す。件数が 0 でも
 * 働いていないとは限らないので、infobox の行を見ること。
 *
 * 合否基準（README/計画と同じ）:
 *   合格 = 固定クエリで実在する今期作品名が 3 件以上取れる
 *   不合格 = ここで止めて、BIORHYTHM_SEASONAL_WORKS だけ日本のアニメDBに当てる案へ
 *
 * 【重要】機械的には「作品名が実在するか」を判定できない。件数とスニペット長は
 * この出力で分かるが、**実在性と鮮度は人が目で見て判断すること**。
 */
import {
  searxngEngines,
  searxngSearch,
  type SearchHit,
} from "../packages/bot_brain/src/api/searxng/index.js";
import { seasonalWorksQueries } from "../packages/bot_brain/src/gemini/grounding.js";
import { fetchReadableText } from "../packages/nagi-linkcard/src/readable.js";

// BIORHYTHM_SEASONAL_WORKS が実際に投げるクエリそのもの。ここを固定文字列で
// 複製すると本番と乖離して Step 0 の意味がなくなるので、必ず本番の実装を呼ぶ。
const DEFAULT_QUERIES = seasonalWorksQueries();

const args = process.argv.slice(2);
const withFetch = args.includes("--fetch");
const custom = args
  .filter((arg) => arg.startsWith("--query="))
  .map((arg) => arg.slice("--query=".length))
  .filter(Boolean);
const queries = custom.length ? custom : DEFAULT_QUERIES;

// エンジンの効き目を比べるための上書き。--env-file で読んだ値より優先させたいので、
// シェルの環境変数ではなくフラグで受ける。
const engines = args
  .filter((arg) => arg.startsWith("--engines="))
  .map((arg) => arg.slice("--engines=".length))
  .filter(Boolean)
  .at(-1);
if (engines) process.env.SEARXNG_ENGINES = engines;

/** 本文取得の対象は上位 2 件まで。本番のワーカーと同じ本数にする。 */
const FETCH_TOP_N = 2;
const SNIPPET_PREVIEW = 160;

function preview(value: string, length = SNIPPET_PREVIEW): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

function reportHits(hits: SearchHit[]): void {
  if (!hits.length) {
    console.log("  (結果なし)");
    return;
  }
  for (const [index, hit] of hits.entries()) {
    console.log(`  [${index + 1}] ${hit.title}`);
    console.log(`      ${hit.url}${hit.engine ? `  (${hit.engine})` : ""}`);
    console.log(
      `      snippet ${hit.content.length}字: ${preview(hit.content) || "(空)"}`,
    );
  }
}

async function reportBodies(hits: SearchHit[]): Promise<void> {
  const targets = hits.slice(0, FETCH_TOP_N);
  if (!targets.length) return;
  console.log(`  --- 上位${targets.length}件の本文取得 ---`);
  for (const hit of targets) {
    const startedAt = Date.now();
    try {
      const { title, text } = await fetchReadableText(hit.url);
      console.log(
        `  [本文OK] ${text.length}字 / ${Date.now() - startedAt}ms  ${title}`,
      );
      console.log(`      ${preview(text, 300)}`);
    } catch (error) {
      // SPA / bot 避けサイトはここで落ちる。落ちる頻度そのものが評価対象。
      console.log(
        `  [本文NG] ${Date.now() - startedAt}ms  ${hit.url}\n      ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.SEARXNG_BASE_URL?.trim()) {
    console.error(
      "SEARXNG_BASE_URL が未設定。searxng/compose.yml で立ててから .env に書くこと。\n" +
        "  例: SEARXNG_BASE_URL=http://127.0.0.1:8080",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`SEARXNG_BASE_URL = ${process.env.SEARXNG_BASE_URL}`);
  console.log(`engines = ${searxngEngines()}`);
  console.log(`本文取得 = ${withFetch ? "あり" : "なし（--fetch で有効）"}\n`);

  let failures = 0;
  for (const query of queries) {
    console.log(`■ ${query}`);
    const startedAt = Date.now();
    try {
      const { hits, infoboxes, unresponsiveEngines } = await searxngSearch(query);
      console.log(
        `  ${hits.length}件 / ${Date.now() - startedAt}ms` +
          (unresponsiveEngines.length
            ? `  ⚠ 応答なし: ${unresponsiveEngines.join(", ")}`
            : ""),
      );
      reportHits(hits);
      if (infoboxes.length) {
        console.log(`  --- infobox ${infoboxes.length}件 ---`);
        for (const box of infoboxes) console.log(`  * ${preview(box, 200)}`);
      }
      if (withFetch) await reportBodies(hits);
      if (!hits.length) failures++;
    } catch (error) {
      failures++;
      console.error(`  [失敗] ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(
    "合否は人が判断すること。固定クエリの結果に、実在する今期作品名が3件以上\n" +
      "含まれているかを目で確かめる。スニペットに作品名が入らない場合は --fetch を\n" +
      "付けて本文取得込みで再判定する。",
  );
  if (failures) {
    console.error(`\n${failures}/${queries.length} 件のクエリが結果ゼロまたは失敗。`);
    process.exitCode = 1;
  }
}

await main();
