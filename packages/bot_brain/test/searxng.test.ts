import assert from "node:assert/strict";
import test from "node:test";
import { isSearxngConfigured, searxngSearch } from "../src/api/searxng/index.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

test.beforeEach(() => {
  process.env.SEARXNG_BASE_URL = "http://192.168.1.220:8080";
  delete process.env.SEARXNG_ENGINES;
  delete process.env.SEARXNG_MAX_RESULTS;
  delete process.env.SEARXNG_TIMEOUT_MS;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

test("shapes SearXNG results into hits", async () => {
  globalThis.fetch = async () =>
    json({
      results: [
        {
          url: "https://example.com/a",
          title: "2026年秋アニメ一覧",
          content: "今期の話題作をまとめました",
          engine: "duckduckgo",
          publishedDate: "2026-09-20T00:00:00Z",
        },
      ],
    });

  const { hits } = await searxngSearch("秋アニメ");
  assert.deepEqual(hits, [
    {
      title: "2026年秋アニメ一覧",
      url: "https://example.com/a",
      content: "今期の話題作をまとめました",
      engine: "duckduckgo",
      publishedDate: "2026-09-20T00:00:00Z",
    },
  ]);
});

test("skips entries missing a url or title rather than emitting blanks", async () => {
  globalThis.fetch = async () =>
    json({
      results: [
        { url: "https://example.com/a" },
        { title: "タイトルだけ" },
        { url: "https://example.com/b", title: "両方ある", content: "" },
      ],
    });

  const { hits } = await searxngSearch("q");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://example.com/b");
  assert.equal(hits[0].content, "");
});

test("truncates to SEARXNG_MAX_RESULTS and clamps it into 1..10", async () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: `t${index}`,
    content: "c",
  }));
  globalThis.fetch = async () => json({ results });

  process.env.SEARXNG_MAX_RESULTS = "2";
  assert.equal((await searxngSearch("q")).hits.length, 2);

  // 上限超えは 10 に、下限割れは 1 に丸める。上流へ過大な負荷を投げない。
  process.env.SEARXNG_MAX_RESULTS = "999";
  assert.equal((await searxngSearch("q")).hits.length, 10);

  process.env.SEARXNG_MAX_RESULTS = "0";
  assert.equal((await searxngSearch("q")).hits.length, 1);

  // 数値でない値は既定(5)に落とす。タイポで検索を止めない。
  process.env.SEARXNG_MAX_RESULTS = "たくさん";
  assert.equal((await searxngSearch("q")).hits.length, 5);
});

test("keeps infoboxes, which are the Wikidata/Wikipedia signal for proper nouns", async () => {
  // wikipedia / wikidata は results ではなく infobox を返す。固有名詞の実在確認は
  // ここでしか取れないので、落とすと RESEARCH_ONLY_NOTE の裏付けが無くなる。
  globalThis.fetch = async () =>
    json({
      results: [],
      infoboxes: [
        {
          infobox: "薬屋のひとりごと",
          content: "日向夏による日本のライトノベル。",
          id: "https://ja.wikipedia.org/wiki/薬屋のひとりごと",
        },
        { content: "ラベルなしでも本文があれば拾う" },
        { infobox: "本文なし" },
        { infobox: "URLでないid", content: "本文", id: "not-a-url" },
      ],
    });

  const { infoboxes } = await searxngSearch("q");
  assert.deepEqual(infoboxes, [
    "薬屋のひとりごと: 日向夏による日本のライトノベル。 (https://ja.wikipedia.org/wiki/薬屋のひとりごと)",
    "ラベルなしでも本文があれば拾う",
    "URLでないid: 本文",
  ]);
});

test("queries bing for lists and wikipedia/wikidata for proper nouns by default", async () => {
  let requested: URL | undefined;
  globalThis.fetch = async (input: any) => {
    requested = new URL(String(input));
    return json({ results: [] });
  };

  await searxngSearch("q");
  const engines = requested?.searchParams.get("engines") ?? "";
  assert.match(engines, /\bbing\b/);
  assert.match(engines, /\bwikipedia\b/);
  // duckduckgo は自前インスタンスに CAPTCHA (jp-jp) を返し続けるので既定から外した。
  assert.doesNotMatch(engines, /duckduckgo/);
});

test("surfaces unresponsive engines so upstream blocking is detectable", async () => {
  globalThis.fetch = async () =>
    json({
      results: [],
      unresponsive_engines: [
        ["duckduckgo", "CAPTCHA"],
        ["bing", "timeout"],
      ],
    });

  const { unresponsiveEngines } = await searxngSearch("q");
  assert.deepEqual(unresponsiveEngines, ["duckduckgo", "bing"]);
});

test("returns empty for a blank query without touching the network", async () => {
  globalThis.fetch = async () => {
    assert.fail("空クエリで検索してはいけない");
  };

  const value = await searxngSearch("   ");
  assert.deepEqual(value, { hits: [], infoboxes: [], unresponsiveEngines: [] });
});

test("sends the query parameters the JSON API needs", async () => {
  let requested: URL | undefined;
  globalThis.fetch = async (input: any) => {
    requested = new URL(String(input));
    return json({ results: [] });
  };

  process.env.SEARXNG_ENGINES = "duckduckgo,wikipedia";
  await searxngSearch("秋アニメ");

  assert.ok(requested);
  assert.equal(requested.pathname, "/search");
  assert.equal(requested.searchParams.get("q"), "秋アニメ");
  // これが無いと SearXNG は HTML を返す（settings.yml の formats と対になる）。
  assert.equal(requested.searchParams.get("format"), "json");
  assert.equal(requested.searchParams.get("language"), "ja");
  assert.equal(requested.searchParams.get("engines"), "duckduckgo,wikipedia");
});

test("trims a trailing slash on the base URL instead of doubling it", async () => {
  let requested: URL | undefined;
  globalThis.fetch = async (input: any) => {
    requested = new URL(String(input));
    return json({ results: [] });
  };

  process.env.SEARXNG_BASE_URL = "http://192.168.1.220:8080/";
  await searxngSearch("q");
  assert.equal(requested?.pathname, "/search");
});

test("throws with the HTTP status attached on a non-2xx response", async () => {
  // 403 は settings.yml の search.formats に json が無いときの典型。
  globalThis.fetch = async () => new Response("Forbidden", { status: 403 });

  await assert.rejects(searxngSearch("q"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /SearXNG HTTP 403/);
    assert.equal((error.cause as { status?: number })?.status, 403);
    return true;
  });
});

test("throws when SEARXNG_BASE_URL is not configured", async () => {
  delete process.env.SEARXNG_BASE_URL;
  assert.equal(isSearxngConfigured(), false);
  await assert.rejects(searxngSearch("q"), /SEARXNG_BASE_URL is not configured/);
});
