import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { OLLAMA_TEXT_CONTEXT_LENGTH } from "@bsky-affirmative-bot/shared-configs";
import { ollamaChat } from "../src/ollamaChat.js";

function withOllamaEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.OLLAMA_MODEL = "local-test-model";
  return run().finally(() => {
    if (previous.base === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
  });
}

/**
 * OpenAI互換ではなくネイティブ /api/chat を使い、think を切り num_ctx を揃える。
 * think を切らないと分類は content が空文字のまま返って死に、num_ctx がずれると
 * 26Bモデルが呼び出しのたびにリロードされる。
 */
test("ネイティブ /api/chat へ think:false と共通num_ctxで投げる", async () => {
  await withOllamaEnv(async () => {
    let url = "";
    let body: any;
    const fetchMock = mock.method(globalThis, "fetch", async (input: any, init: any) => {
      url = String(input);
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ message: { content: "positive" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const text = await ollamaChat(
        "OLLAMA_PREDEFINED_AFFIRMATION",
        [{ role: "user", content: "できた！" }],
        { maxTokens: 5 },
      );
      assert.equal(text, "positive");
      // OLLAMA_BASE_URL の末尾 /v1 は剥がす。
      assert.equal(url, "http://ollama.test:11434/api/chat");
      assert.equal(body.think, false);
      assert.equal(body.stream, false);
      assert.equal(body.options.num_predict, 5);
      assert.equal(body.options.num_ctx, OLLAMA_TEXT_CONTEXT_LENGTH);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
