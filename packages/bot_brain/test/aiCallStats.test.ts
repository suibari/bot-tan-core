import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  reportAiCall,
  reportGenerationHealthFailureAsync,
  reportGenerationHeartbeatAsync,
  setGenerationTelemetrySinkForTest,
  type GenerationTelemetrySink,
} from "../src/gemini/aiCallStats.js";
import { gemini } from "../src/gemini/index.js";
import { generateContentForProvider } from "../src/gemini/generationClient.js";
import { generateContentWithRetry } from "../src/gemini/util.js";

const counted: string[] = [];
const healthEvents: string[] = [];
const recordingSink: GenerationTelemetrySink = {
  async incrementStats(type) {
    counted.push(type);
  },
  async reportHeartbeat(service) {
    healthEvents.push(`ok:${service}`);
  },
  async reportHealthFailure(service) {
    healthEvents.push(`error:${service}`);
  },
};
const restoreTelemetrySink = setGenerationTelemetrySinkForTest(recordingSink);
test.after(restoreTelemetrySink);

function withOllamaEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  return run().finally(() => {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
  });
}

/**
 * 計上は fire-and-forget で、中で database を動的importするため解決までに数tick要る。
 * 固定待ちにせず、期待する件数が積まれるまでポーリングする。
 */
async function waitForCount(expected: number) {
  for (let i = 0; i < 200 && counted.length < expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForHealthEvents(expected: number) {
  for (let i = 0; i < 200 && healthEvents.length < expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("クラウドとローカルは別のカウンタキーを使う", async () => {
  // rpd は Gemini の日次上限判定(checkRPD)にそのまま使われるため、ローカル生成を
  // 混ぜてはいけない。混ぜると課金枠を使っていないのに上限扱いで bsky が止まる。
  counted.length = 0;
  await reportAiCall("gemini", "ok");
  await reportAiCall("gemini", "error");
  await reportAiCall("ollama", "ok");
  await reportAiCall("ollama", "error");
  assert.deepEqual(counted, ["rpd", "rpdError", "localRpd", "localRpdError"]);
});

test("クラウドとローカルは別のヘルスキーを使う", async () => {
  healthEvents.length = 0;
  reportGenerationHeartbeatAsync("gemini");
  reportGenerationHealthFailureAsync("gemini", new Error("cloud"));
  reportGenerationHeartbeatAsync("ollama");
  reportGenerationHealthFailureAsync("ollama", new Error("local"));
  await waitForHealthEvents(4);
  assert.deepEqual(healthEvents, [
    "ok:gemini",
    "error:gemini",
    "ok:local-llm",
    "error:local-llm",
  ]);
});

test("generateContentWithRetryの成功をGeminiの計上とヘルスへ送る", async () => {
  counted.length = 0;
  healthEvents.length = 0;
  const generateContent = mock.method(
    gemini.models,
    "generateContent",
    async () => ({ text: "ok" }) as any,
  );
  try {
    const response = await generateContentWithRetry(
      { model: "test-model", contents: "hello" },
      0,
    );
    assert.equal(response.text, "ok");
    await Promise.all([waitForCount(1), waitForHealthEvents(1)]);
    assert.deepEqual(counted, ["rpd"]);
    assert.deepEqual(healthEvents, ["ok:gemini"]);
  } finally {
    generateContent.mock.restore();
  }
});

test("ローカル生成の成功は localRpd に入る", async () => {
  await withOllamaEnv(async () => {
    counted.length = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ message: { content: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const response = await generateContentForProvider("ollama", {
        model: "local-test-model",
        contents: "hello",
      });
      assert.equal(response.text, "ok");
      await waitForCount(1);
      assert.deepEqual(counted, ["localRpd"]);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test("ローカル生成の失敗は localRpdError に入り、例外は呼び出し元へ投げ返す", async () => {
  await withOllamaEnv(async () => {
    counted.length = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response("boom", { status: 500 }),
    );
    try {
      await assert.rejects(
        generateContentForProvider("ollama", {
          model: "local-test-model",
          contents: "hello",
        }),
        /Ollama HTTP 500/,
      );
      await waitForCount(1);
      assert.deepEqual(counted, ["localRpdError"]);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
