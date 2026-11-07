import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkSearxngRelevance,
  enginesToCheck,
  isRelevant,
  summarizeRelevance,
} from "../src/searxngRelevance.js";

/**
 * 検索結果の中身の監視。
 *
 * 例は 2026-11-07 に実際に起きた汚染。HTTP 200・件数もそろうので /healthz では気づけない。
 *   - Yahoo（自宅 IPv4）: 「超融合」でアパートの間取り（Summer Place Apartment Homes）
 *   - Bing: 「葬送のフリーレン」→ 頭の一語「葬送」の結果
 */

const hit = (title: string, content = "", url = "https://example.com/") => ({ title, content, url });
const response = (...hits: ReturnType<typeof hit>[]) => ({ hits, infoboxes: [], unresponsiveEngines: [] });

test("上位3件のどれかに期待する語があれば関連ありとする", () => {
  const canary = { query: "超融合 遊戯王", expect: ["超融合"] };
  assert.equal(isRelevant(response(hit("ヤフオク!"), hit("遊戯王カードWiki - 《超融合》")), canary), true);
  assert.equal(isRelevant(response(hit("Summer Place Apartment Homes"), hit("Floor Plans")), canary), false);
  // 4位以下は数えない。
  assert.equal(isRelevant(response(hit("a"), hit("b"), hit("c"), hit("超融合")), canary), false);
});

test("照合は大文字小文字・全角半角・URL の中の語も見る", () => {
  const canary = { query: "Puella Magi Madoka Magica", expect: ["madoka"] };
  assert.equal(isRelevant(response(hit("PUELLA MAGI ＭＡＤＯＫＡ")), canary), true);
  assert.equal(isRelevant(response(hit("Wiki", "", "https://en.wikipedia.org/wiki/Madoka")), canary), true);
  assert.equal(isRelevant(response(hit("Wiki", "", "https://example.com/%E3%81%BE%")), canary), false, "壊れた URL でも落ちない");
});

test("監視するのは通常の結果を返すエンジンだけ（wikipedia / wikidata は infobox だけ）", () => {
  assert.deepEqual(enginesToCheck("yahoo,bing,wikipedia,wikidata"), ["yahoo", "bing"]);
  assert.deepEqual(enginesToCheck("wikipedia"), []);
});

test("一部のエンジンだけ汚染されていれば stale、全滅なら down、何も無ければ unconfigured", () => {
  const ok = { engine: "yahoo", passed: 3, total: 3, failures: [] };
  const bad = { engine: "bing", passed: 1, total: 3, failures: [{ query: "葬送のフリーレン", top: "葬送 - Wikipedia" }] };
  assert.equal(summarizeRelevance([ok]).state, "ok");
  const partial = summarizeRelevance([ok, bad]);
  assert.equal(partial.state, "stale");
  assert.equal(partial.lastError, "bing: 1/3（「葬送のフリーレン」→ 葬送 - Wikipedia）");
  assert.equal(summarizeRelevance([{ ...ok, passed: 0 }, bad]).state, "down");
  assert.equal(summarizeRelevance([]).state, "unconfigured");
});

test("2/3 の語で期待どおりなら正常とみなす（たまの外れで騒がない）", () => {
  assert.equal(summarizeRelevance([{ engine: "yahoo", passed: 2, total: 3, failures: [] }]).state, "ok");
});

test("エンジンごとに1つずつ検索し、エラーも外れとして記録する", async () => {
  const calls: string[] = [];
  const result = await checkSearxngRelevance({
    engines: ["yahoo", "bing"],
    canaries: [{ query: "超融合 遊戯王", expect: ["超融合"] }, { query: "葬送のフリーレン", expect: ["フリーレン"] }],
    search: async (query, options) => {
      calls.push(`${options.engines}:${query}`);
      assert.equal(options.source, "probe");
      if (options.engines === "bing") throw new Error("SearXNG HTTP 429");
      return response(hit(query.includes("超融合") ? "遊戯王カードWiki - 《超融合》" : "Summer Place Apartment Homes"));
    },
  });
  assert.deepEqual(calls, [
    "yahoo:超融合 遊戯王", "yahoo:葬送のフリーレン",
    "bing:超融合 遊戯王", "bing:葬送のフリーレン",
  ]);
  assert.equal(result.state, "down");
  assert.match(result.lastError ?? "", /yahoo: 1\/2（「葬送のフリーレン」→ Summer Place Apartment Homes）/);
  assert.match(result.lastError ?? "", /bing: 0\/2（「超融合 遊戯王」→ エラー: SearXNG HTTP 429）/);
});

test("監視は startWorkerLoop で回し、setInterval を直に書かない", () => {
  const code = readFileSync(new URL("../src/searxngRelevance.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bsetInterval\s*\(/);
  assert.match(code, /startWorkerLoop\(\{/);
});
