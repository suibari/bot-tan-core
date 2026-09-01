import assert from "node:assert/strict";
import test from "node:test";
import {
  replyWithUnknownTermsSchema,
  sanitizeUnknownTerms,
} from "../src/gemini/unknownTerms.js";

/**
 * 「知らなかった語」の申告。
 *
 * 返信を書いたモデル自身が生成と同じ1回のリクエストで出すので、判定用の LLM 呼び出しも
 * 正規表現も要らない。ここで守るのは、その申告をキューへ渡す前の掃除。
 */

test("重複と表記揺れをまとめ、短すぎる語を落とす", () => {
  assert.deepEqual(
    sanitizeUnknownTerms([
      "薬屋のひとりごと",
      "  薬屋のひとりごと  ",
      "ブラッククローバー",
      "あ",
      "",
      123,
      null,
    ]),
    ["薬屋のひとりごと", "ブラッククローバー"],
  );
});

test("ASCIIの大小文字違いは同じ語として1件にする", () => {
  assert.deepEqual(sanitizeUnknownTerms(["Bluesky", "bluesky"]), ["Bluesky"]);
});

test("URLは語として扱わない", () => {
  // URL は planner を経ずに本文取得へ回る経路がある。語として検索しても意味がない。
  assert.deepEqual(
    sanitizeUnknownTerms(["https://example.com/a", "薬屋のひとりごと"]),
    ["薬屋のひとりごと"],
  );
});

test("件数と長さに上限を掛ける", () => {
  const many = Array.from({ length: 20 }, (_, index) => `作品${index}`);
  assert.equal(sanitizeUnknownTerms(many).length, 5);
  assert.equal(sanitizeUnknownTerms(["あ".repeat(200)])[0].length, 60);
});

test("配列でない申告は無視する", () => {
  for (const value of [undefined, null, "薬屋のひとりごと", {}, 0]) {
    assert.deepEqual(sanitizeUnknownTerms(value), []);
  }
});

test("自由文の機能へ渡すスキーマは reply を必須にする", () => {
  // reply が欠けると返信そのものが消える。unknownTerms は空でよい。
  const schema = replyWithUnknownTermsSchema() as any;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["reply"]);
  assert.equal(schema.properties.reply.type, "string");
  assert.equal(schema.properties.unknownTerms.type, "array");
});

/** Ollama を1回だけ捕まえ、返す本文をテストごとに差し替える。 */
async function withStubbedOllama<T>(
  content: string,
  run: () => Promise<T>,
): Promise<{ value: T; request: any }> {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  const originalFetch = globalThis.fetch;
  let request: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    request = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ model: "local-test", message: { content } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    return { value: await run(), request };
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
}

test("気まぐれリプライは構造化出力を解いて本文だけを返す", async () => {
  // ここが漏れると、利用者に生の JSON がリプライとして届く。
  const { generateSingleResponse } = await import("../src/gemini/util.js");
  const { value: text, request } = await withStubbedOllama(
    JSON.stringify({
      reply: "そうなんだ、教えてくれてありがとう！",
      unknownTerms: ["薬屋のひとりごと"],
    }),
    () => generateSingleResponse("薬屋のひとりごと見た！", undefined, "BSKY_WHIMSICAL_REPLY"),
  );

  assert.equal(text, "そうなんだ、教えてくれてありがとう！");
  assert.doesNotMatch(text, /unknownTerms/, "JSONが漏れていない");
  const system = request.messages.find((m: any) => m.role === "system")?.content ?? "";
  assert.match(system, /unknownTerms/, "申告を促す指示が乗っている");
  assert.equal(request.format.properties.reply.type, "string", "スキーマで縛っている");
});

test("構造化に失敗しても素のテキストとして返す", async () => {
  const { generateSingleResponse } = await import("../src/gemini/util.js");
  const { value: text } = await withStubbedOllama("JSONじゃない普通の返事", () =>
    generateSingleResponse("やっほー", undefined, "BSKY_WHIMSICAL_REPLY"),
  );
  assert.equal(text, "JSONじゃない普通の返事", "生成そのものは落とさない");
});

test("deferred以外の機能は構造化しない", async () => {
  // おみくじ等は従来どおり自由文。ここへ巻き込むと出力形式が変わる。
  const { generateSingleResponse } = await import("../src/gemini/util.js");
  const { request } = await withStubbedOllama("大吉だよ！", () =>
    generateSingleResponse("おみくじ", undefined, "BSKY_OMIKUJI"),
  );
  assert.equal(request.format, undefined);
  const system = request.messages.find((m: any) => m.role === "system")?.content ?? "";
  assert.doesNotMatch(system, /unknownTerms/);
});
