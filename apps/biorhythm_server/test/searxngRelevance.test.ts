import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkSearxngRelevance,
  classifyCanary,
  enginesToCheck,
  formatRelevanceSummary,
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

test("エンジンごとに1つずつ検索し、gateway の 429 は制限として外れに数える", async () => {
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
  assert.match(result.lastError ?? "", /bing: 0\/2（「超融合 遊戯王」→ 制限: SearXNG HTTP 429）/);
});

test("監視は startWorkerLoop で回し、setInterval を直に書かない", () => {
  const code = readFileSync(new URL("../src/searxngRelevance.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bsetInterval\s*\(/);
  assert.match(code, /startWorkerLoop\(\{/);
});

/**
 * 2026-11-09 10:09 / 16:09 の誤報。1語目で Yahoo が timeout（16:09 は接続エラー）になると、
 * SearXNG が Yahoo を数秒 Suspended にし、続く2語も 0件になって「0/3 → down」になっていた。
 * 結果の中身は汚染されていなかった。
 */
const unresponsive = (engine: string, reason: string) => ({
  hits: [],
  infoboxes: [],
  unresponsiveEngines: [engine],
  unresponsiveReasons: { [engine]: reason },
});

test("答えが返らなかった語は、制限の文言なら blocked、それ以外は unanswered に分ける", () => {
  const canary = { query: "葬送のフリーレン", expect: ["フリーレン"] };
  assert.deepEqual(classifyCanary("yahoo", unresponsive("yahoo", "timeout"), canary), { kind: "unanswered", reason: "timeout" });
  assert.deepEqual(classifyCanary("yahoo", unresponsive("yahoo", "Suspended: HTTP error"), canary), { kind: "unanswered", reason: "Suspended: HTTP error" });
  assert.equal(classifyCanary("yahoo", unresponsive("yahoo", "too many requests"), canary).kind, "blocked");
  assert.equal(classifyCanary("yahoo", unresponsive("yahoo", "Suspended: CAPTCHA"), canary).kind, "blocked");
  assert.equal(classifyCanary("yahoo", unresponsive("yahoo", "access denied"), canary).kind, "blocked");
  // 別のエンジンが応答しなかっただけなら、このエンジンは答えている。0件は「無関係」側。
  assert.deepEqual(classifyCanary("yahoo", unresponsive("wikidata", "timeout"), canary), { kind: "irrelevant", top: "" });
});

test("timeout の後の Suspended 巻き添えは、待って引き直せば正しく判定できる", async () => {
  const sleeps: number[] = [];
  let suspended = false;
  const result = await checkSearxngRelevance({
    engines: ["yahoo"],
    canaries: [
      { query: "葬送のフリーレン", expect: ["フリーレン"] },
      { query: "超融合 遊戯王", expect: ["超融合"] },
    ],
    sleep: async (ms) => { sleeps.push(ms); suspended = false; },
    search: async (query) => {
      if (suspended) return unresponsive("yahoo", "Suspended: timeout");
      if (query === "葬送のフリーレン" && !sleeps.length) {
        suspended = true;
        return unresponsive("yahoo", "timeout");
      }
      return response(hit(`${query} - Wikipedia`));
    },
  });
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! > 5_000, "SearXNG の ban_time_on_fail（既定5秒）より長く待つ");
  assert.equal(result.state, "ok");
  assert.deepEqual(result.engines[0], { engine: "yahoo", passed: 2, total: 2, failures: [], unanswered: [] });
});

test("引き直しても答えない語は判定から外し、汚染とは扱わない", async () => {
  const result = await checkSearxngRelevance({
    engines: ["yahoo"],
    canaries: [
      { query: "葬送のフリーレン", expect: ["フリーレン"] },
      { query: "超融合 遊戯王", expect: ["超融合"] },
      { query: "Puella Magi Madoka Magica", expect: ["madoka"] },
    ],
    sleep: async () => {},
    search: async (query) =>
      query === "葬送のフリーレン" ? unresponsive("yahoo", "timeout") : response(hit(`${query} - Wikipedia`)),
  });
  assert.equal(result.state, "ok");
  assert.equal(formatRelevanceSummary(result.engines), "yahoo=2/2（確認できず1: timeout）");
});

test("1語も答えなければ unknown（汚染とも正常とも言えない）。最後に正常だった時刻は付けない", async () => {
  const result = await checkSearxngRelevance({
    engines: ["yahoo"],
    canaries: [{ query: "葬送のフリーレン", expect: ["フリーレン"] }, { query: "超融合 遊戯王", expect: ["超融合"] }],
    sleep: async () => {},
    search: async () => unresponsive("yahoo", "Suspended: timeout"),
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.lastOkAt, undefined);
  assert.equal(result.lastError, "確認できず: yahoo（2語: Suspended: timeout）");
});

test("制限（too many requests）は引き直さず、外れとして down にする", async () => {
  let calls = 0;
  const result = await checkSearxngRelevance({
    engines: ["yahoo"],
    canaries: [{ query: "葬送のフリーレン", expect: ["フリーレン"] }],
    sleep: async () => assert.fail("制限は引き直さない"),
    search: async () => { calls++; return unresponsive("yahoo", "too many requests"); },
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "down");
  assert.equal(result.lastError, "yahoo: 0/1（「葬送のフリーレン」→ 制限: too many requests）");
});

test("ネットワークの例外は unanswered として1回引き直す", async () => {
  let calls = 0;
  const result = await checkSearxngRelevance({
    engines: ["yahoo"],
    canaries: [{ query: "葬送のフリーレン", expect: ["フリーレン"] }],
    sleep: async () => {},
    search: async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed");
      return response(hit("葬送のフリーレン - Wikipedia"));
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.state, "ok");
});
