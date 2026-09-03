import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
 * OpenAI互換ではなくネイティブ /api/chat を使い、think を切る。think を切らないと
 * 分類は content が空文字のまま返って死ぬ。
 *
 * **num_ctx は送らない。** Ollama は num_ctx が違うと同じモデルでも runner を作り直す。
 * 送る値を持つと systemd 側と揃え忘れたときに26Bモデルがリロードされ続けるので、
 * サーバの OLLAMA_CONTEXT_LENGTH を唯一の源にしている。
 */
test("ネイティブ /api/chat へ think:false で投げ、num_ctx は送らない", async () => {
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
      assert.ok(
        !("num_ctx" in body.options),
        "num_ctx はサーバ既定に任せる（送るとrunnerの作り直しを誘発する）",
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});
