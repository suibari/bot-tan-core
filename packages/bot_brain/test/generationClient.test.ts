import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  generateOllamaContent,
  normalizeJsonSchema,
  toOllamaMessages,
} from "../src/gemini/generationClient.js";
import {
  groundingPolicyForFeature,
  prepareOllamaGrounding,
} from "../src/gemini/grounding.js";

test("Gemini形式のsystem・履歴・画像をOllama chatへ変換する", () => {
  assert.deepEqual(
    toOllamaMessages({
      config: { systemInstruction: "persona" },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
        {
          role: "user",
          parts: [{ text: "look" }, { inlineData: { data: "BASE64", mimeType: "image/png" } }],
        },
      ],
    }),
    [
      { role: "system", content: "persona" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "look", images: ["BASE64"] },
    ],
  );
});

test("Google Type enumをOllama用JSON Schemaへ正規化する", () => {
  assert.deepEqual(
    normalizeJsonSchema({
      type: "OBJECT",
      properties: { values: { type: "ARRAY", items: { type: "STRING" } } },
      propertyOrdering: ["values"],
    }),
    {
      type: "object",
      properties: { values: { type: "array", items: { type: "string" } } },
    },
  );
});

test("function declarationをschema出力へ変換しfunctionCalls互換で返す", async () => {
  const saved = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  let requestBody: any;
  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model: "local-test",
      message: { content: '{"title":"朝のお散歩"}' },
      prompt_eval_count: 10,
      eval_count: 5,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const response = await generateOllamaContent({
      model: "local-test",
      contents: ["plan"],
      config: {
        tools: [{
          functionDeclarations: [{
            name: "compose",
            parameters: {
              type: "OBJECT",
              properties: { title: { type: "STRING" } },
              required: ["title"],
            },
          }],
        }],
      },
    });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(requestBody.format.type, "object");
    assert.equal(requestBody.format.properties.title.type, "string");
    assert.deepEqual(response.functionCalls, [
      { name: "compose", args: { title: "朝のお散歩" } },
    ]);
  } finally {
    fetchMock.mock.restore();
    if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = saved;
  }
});

test("groundingポリシーは用途ごとに分離される", () => {
  assert.equal(groundingPolicyForFeature("BSKY_CONVERSATION"), "auto");
  assert.equal(groundingPolicyForFeature("BIORHYTHM_SEASONAL_WORKS"), "required");
  assert.equal(groundingPolicyForFeature("NEWS_POSITIVE_COMMENT"), "preferred");
  assert.equal(groundingPolicyForFeature("BSKY_BOT_DIARY"), "off");
});

test("Gemini調査へはplannerが作った検索語とURLだけを渡す", async () => {
  const saved = process.env.AI_GROUNDING_PROVIDER;
  process.env.AI_GROUNDING_PROVIDER = "gemini";
  const sensitive = "did:plc:secret-user 会話履歴の秘密 https://example.com/post";
  let researchInput: { queries: string[]; urls: string[] } | undefined;
  try {
    const result = await prepareOllamaGrounding(
      "BSKY_CONVERSATION",
      {
        model: "local-test",
        contents: [{ role: "user", parts: [{ text: sensitive }] }],
        config: { tools: [{ googleSearch: {} }, { urlContext: {} }] },
      },
      {
        plan: async (_model, subject) => {
          assert.equal(subject, sensitive, "生入力を見るのはローカルplannerだけ");
          return {
            needed: true,
            queries: ["対象トピック 最新情報"],
            urls: ["https://example.com/post"],
          };
        },
        research: async (input) => {
          researchInput = input;
          return "確認済みの中立な事実 https://source.example/";
        },
      },
    );
    assert.deepEqual(researchInput, {
      queries: ["対象トピック 最新情報"],
      urls: ["https://example.com/post"],
    });
    assert.doesNotMatch(JSON.stringify(researchInput), /secret-user|会話履歴の秘密/);
    assert.doesNotMatch(JSON.stringify(result.config), /googleSearch|urlContext/);
    assert.match(JSON.stringify(result.contents), /grounding_research/);
  } finally {
    if (saved === undefined) delete process.env.AI_GROUNDING_PROVIDER;
    else process.env.AI_GROUNDING_PROVIDER = saved;
  }
});

test("検索必須機能はgrounding失敗を握り潰さない", async () => {
  await assert.rejects(
    prepareOllamaGrounding(
      "BIORHYTHM_SEASONAL_WORKS",
      {
        model: "local-test",
        contents: ["今期作品"],
        config: { tools: [{ googleSearch: {} }] },
      },
      {
        plan: async () => ({ needed: true, queries: ["今期 作品"], urls: [] }),
        research: async () => { throw new Error("grounding down"); },
      },
    ),
    /grounding down/,
  );
});

test("現在情報を含む会話はローカルplannerへ検索必須として渡す", async () => {
  let forced: boolean | undefined;
  await prepareOllamaGrounding(
    "BSKY_CONVERSATION",
    {
      model: "local-test",
      contents: ["2026年8月時点の横浜の最近の暑さを確認して"],
      config: { tools: [{ googleSearch: {} }] },
    },
    {
      plan: async (_model, _subject, required) => {
        forced = required;
        return { needed: false, queries: [], urls: [] };
      },
    },
  );
  assert.equal(forced, true);
});

test("季節作品はplannerが空でも匿名の定型検索へフォールバックする", async () => {
  let input: { queries: string[]; urls: string[] } | undefined;
  await prepareOllamaGrounding(
    "BIORHYTHM_SEASONAL_WORKS",
    {
      model: "local-test",
      contents: ["今期作品"],
      config: { tools: [{ googleSearch: {} }] },
    },
    {
      plan: async () => ({ needed: true, queries: [], urls: [] }),
      research: async (value) => {
        input = value;
        return "verified";
      },
    },
  );
  assert.deepEqual(input?.queries, [
    "現在 日本 今期 話題 アニメ マンガ ゲーム ドラマ 映画 音楽",
  ]);
});
