import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchReadableText } from "../src/readable.js";

test("Wikipedia本文を認証付き共通APIへ送り、失敗時も直接接続しない", async () => {
  const originalFetch = globalThis.fetch;
  const env = { ...process.env };
  try {
    process.env.SEARXNG_BASE_URL = "http://192.168.1.200:8080";
    process.env.SEARXNG_API_KEY = "test-token";
    const requested: string[] = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      requested.push(url.hostname);
      assert.equal(url.pathname, "/wikipedia/ja");
      assert.equal(url.searchParams.get("titles"), "初音ミク");
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-token");
      return new Response(JSON.stringify({ query: { pages: { "1": { title: "初音ミク", extract: "確認済みの本文" } } } }));
    };
    assert.deepEqual(await fetchReadableText("https://ja.wikipedia.org/wiki/初音ミク", 4),
      { title: "初音ミク", text: "確認済み" });
    globalThis.fetch = async (input) => {
      requested.push(new URL(String(input)).hostname);
      return new Response("Unavailable", { status: 503 });
    };
    await assert.rejects(fetchReadableText("https://ja.wikipedia.org/wiki/初音ミク"), /HTTP 503/);
    assert.deepEqual(requested, ["192.168.1.200", "192.168.1.200"]);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = env;
  }
});
