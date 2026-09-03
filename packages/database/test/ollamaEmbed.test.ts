import assert from "node:assert/strict";
import test from "node:test";
import {
  embedSearchQuery,
  filterRelatedHistory,
  generateEmbedding,
  generateEmbeddings,
  searchQueryPrefix,
} from "../src/ollamaEmbed.js";

const original = {
  baseUrl: process.env.OLLAMA_BASE_URL,
  embedBaseUrl: process.env.OLLAMA_EMBED_BASE_URL,
  timeoutMs: process.env.OLLAMA_EMBED_TIMEOUT_MS,
  cooldownMs: process.env.OLLAMA_EMBED_COOLDOWN_MS,
  queryPrefix: process.env.OLLAMA_QUERY_PREFIX,
  fetch: globalThis.fetch,
  now: Date.now,
};

const restore = () => {
  if (original.baseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = original.baseUrl;
  if (original.embedBaseUrl === undefined) delete process.env.OLLAMA_EMBED_BASE_URL;
  else process.env.OLLAMA_EMBED_BASE_URL = original.embedBaseUrl;
  if (original.timeoutMs === undefined)
    delete process.env.OLLAMA_EMBED_TIMEOUT_MS;
  else process.env.OLLAMA_EMBED_TIMEOUT_MS = original.timeoutMs;
  if (original.cooldownMs === undefined)
    delete process.env.OLLAMA_EMBED_COOLDOWN_MS;
  else process.env.OLLAMA_EMBED_COOLDOWN_MS = original.cooldownMs;
  if (original.queryPrefix === undefined) delete process.env.OLLAMA_QUERY_PREFIX;
  else process.env.OLLAMA_QUERY_PREFIX = original.queryPrefix;
  globalThis.fetch = original.fetch;
  Date.now = original.now;
};

test("Ollama embedding timeout opens a circuit and recovers after cooldown", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  process.env.OLLAMA_EMBED_TIMEOUT_MS = "10";
  process.env.OLLAMA_EMBED_COOLDOWN_MS = "1000";
  let now = 1_000;
  Date.now = () => now;
  let calls = 0;

  globalThis.fetch = ((_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      // AbortSignal.timeout() の内部タイマーは unref されるため、テストプロセスを
      // abort まで生かす通常タイマーも置く。
      const guard = setTimeout(() => reject(new Error("abort did not fire")), 100);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(guard);
        reject(init.signal?.reason);
      });
    });
  }) as typeof fetch;

  try {
    assert.equal(await generateEmbedding("timeout"), null);
    assert.equal(calls, 1);

    assert.deepEqual(await generateEmbeddings(["circuit", "open"]), [null, null]);
    assert.equal(calls, 1, "cooldown中はOllamaを再呼び出さない");

    now += 1_001;
    const vector = Array.from({ length: 1024 }, () => 0.5);
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    assert.deepEqual(await generateEmbedding("recovered"), vector);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("related-history fallback can reject unrelated candidates", async () => {
  delete process.env.OLLAMA_BASE_URL;
  try {
    const candidates = ["newest unrelated", "older unrelated"];
    assert.deepEqual(
      await filterRelatedHistory("query", candidates, 1, 0.6, "head"),
      ["newest unrelated"],
    );
    assert.deepEqual(
      await filterRelatedHistory("query", candidates, 1, 0.6, "empty"),
      [],
    );
  } finally {
    restore();
  }
});

// --- 検索クエリの接頭辞 -------------------------------------------------------
// 文書側とクエリ側で接頭辞の扱いを取り違えると、評価で出た数字が本番で再現しない。
// 実際に Ollama へ送られる input を捕まえて検証する。

/** fetch を差し替えて、送られた input を記録しつつ 1024次元のダミーを返す。 */
const captureInput = (sink: unknown[]) => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  globalThis.fetch = ((_url, init) => {
    const body = JSON.parse(String(init?.body));
    sink.push(body.input);
    const one = Array.from({ length: 1024 }, () => 0.1);
    const count = Array.isArray(body.input) ? body.input.length : 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: one })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
};

test("searchQueryPrefix は env の \\n を実改行へ展開する", () => {
  process.env.OLLAMA_QUERY_PREFIX = "Instruct: find posts\\nQuery: ";
  assert.equal(searchQueryPrefix(), "Instruct: find posts\nQuery: ");
  restore();
});

test("searchQueryPrefix は未設定なら空文字（既存環境を壊さない）", () => {
  delete process.env.OLLAMA_QUERY_PREFIX;
  assert.equal(searchQueryPrefix(), "");
  restore();
});

test("embedSearchQuery はクエリに接頭辞を付け、generateEmbedding は付けない", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_QUERY_PREFIX = "query: ";
  try {
    await embedSearchQuery("ワルプルギス");
    await generateEmbedding("ワルプルギス");
    assert.deepEqual(sent, ["query: ワルプルギス", "ワルプルギス"]);
  } finally {
    restore();
  }
});

test("embedSearchQuery は Qwen3 形式の instruction を改行込みで送る", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_QUERY_PREFIX =
    "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\\nQuery: ";
  try {
    await embedSearchQuery("まどマギ");
    assert.deepEqual(sent, [
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: まどマギ",
    ]);
  } finally {
    restore();
  }
});

test("embedSearchQuery は空文字・空白のみなら Ollama を呼ばない", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_QUERY_PREFIX = "query: ";
  try {
    assert.equal(await embedSearchQuery(""), null);
    assert.equal(await embedSearchQuery("   "), null);
    assert.deepEqual(sent, [], "接頭辞だけを埋め込んでしまわないこと");
  } finally {
    restore();
  }
});

test("embedSearchQuery はクエリ前後の空白を落としてから接頭辞を付ける", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_QUERY_PREFIX = "query: ";
  try {
    await embedSearchQuery("  散歩  ");
    assert.deepEqual(sent, ["query: 散歩"]);
  } finally {
    restore();
  }
});
