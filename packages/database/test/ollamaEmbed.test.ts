import assert from "node:assert/strict";
import test from "node:test";
import { resetAiRouteCache } from "@bsky-affirmative-bot/shared-configs";
import { resetEmbeddingProfileWarnings } from "../src/embeddingProfiles.js";
import {
  embedSearchQuery,
  filterRelatedHistory,
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingAvailable,
  searchQueryPrefix,
  splitEmbeddingBatches,
} from "../src/ollamaEmbed.js";

const original = {
  baseUrl: process.env.OLLAMA_BASE_URL,
  embedBaseUrl: process.env.OLLAMA_EMBED_BASE_URL,
  timeoutMs: process.env.OLLAMA_EMBED_TIMEOUT_MS,
  cooldownMs: process.env.OLLAMA_EMBED_COOLDOWN_MS,
  embedModel: process.env.OLLAMA_EMBED_MODEL,
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
  if (original.embedModel === undefined) delete process.env.OLLAMA_EMBED_MODEL;
  else process.env.OLLAMA_EMBED_MODEL = original.embedModel;
  resetAiRouteCache();
  resetEmbeddingProfileWarnings();
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

test("searchQueryPrefix は埋め込みモデルに対応した接頭辞を返す", () => {
  // env ではなく embeddingProfiles.ts のテーブル由来。モデルを変えれば接頭辞も追随する。
  process.env.OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b";
  resetAiRouteCache();
  assert.match(searchQueryPrefix(), /^Instruct: .*\nQuery: $/);

  process.env.OLLAMA_EMBED_MODEL = "snowflake-arctic-embed2";
  resetAiRouteCache();
  assert.equal(searchQueryPrefix(), "query: ");
  restore();
});

test("未知の埋め込みモデルでは接頭辞を付けない（間違った接頭辞は本文として埋まる）", () => {
  process.env.OLLAMA_EMBED_MODEL = "some-unregistered-model";
  resetAiRouteCache();
  resetEmbeddingProfileWarnings();
  assert.equal(searchQueryPrefix(), "");
  restore();
});

test("embedSearchQuery はクエリに接頭辞を付け、generateEmbedding は付けない", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_EMBED_MODEL = "snowflake-arctic-embed2";
  resetAiRouteCache();
  try {
    await embedSearchQuery("ワルプルギス");
    await generateEmbedding("ワルプルギス");
    // 文書側に接頭辞を付けると接頭辞そのものが本文として埋まり、全文書が同じ方向へ寄る。
    assert.deepEqual(sent, ["query: ワルプルギス", "ワルプルギス"]);
  } finally {
    restore();
  }
});

test("Qwen3 では instruction を改行込みで送る", async () => {
  const sent: unknown[] = [];
  captureInput(sent);
  process.env.OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b";
  resetAiRouteCache();
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
  process.env.OLLAMA_EMBED_MODEL = "snowflake-arctic-embed2";
  resetAiRouteCache();
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
  process.env.OLLAMA_EMBED_MODEL = "snowflake-arctic-embed2";
  resetAiRouteCache();
  try {
    await embedSearchQuery("  散歩  ");
    assert.deepEqual(sent, ["query: 散歩"]);
  } finally {
    restore();
  }
});

// --- バッチのタイムアウトと分割 ---------------------------------------------
// 件数比例の予算は短い投稿が前提で、平均1200字の web_research が混ざると毎回時間切れになった
// （2026-10-09、1日130回）。予算は文字数に比例させ、長い送信は分ける。

const envKeys = [
  "OLLAMA_EMBED_TIMEOUT_PER_CHAR_MS",
  "OLLAMA_EMBED_MAX_BATCH_CHARS",
  "OLLAMA_EMBED_MAX_INPUT_CHARS",
];
const clearSizeEnv = () => {
  for (const key of envKeys) delete process.env[key];
};

/** delayMs 後に count 件を返す fetch。abort されたら reject する。 */
const slowFetch = (delayMs: number) =>
  ((_url: unknown, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body));
    const count = Array.isArray(body.input) ? body.input.length : 1;
    const one = Array.from({ length: 1024 }, () => 0.1);
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({
                data: Array.from({ length: count }, () => ({ embedding: one })),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        delayMs,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
  }) as typeof fetch;

test("埋め込みのタイムアウトは文字数に比例する", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  // 短文なら予算 ≒ 60ms、200字なら 60 + 200*2 = 460ms。応答は 200ms かかる。
  process.env.OLLAMA_EMBED_TIMEOUT_MS = "60";
  process.env.OLLAMA_EMBED_TIMEOUT_PER_CHAR_MS = "2";
  // 1件目の失敗で開くサーキットを、次の検証まで持ち越さない。
  process.env.OLLAMA_EMBED_COOLDOWN_MS = "1";
  globalThis.fetch = slowFetch(200);

  try {
    assert.equal(
      await generateEmbedding("短い"),
      null,
      "短文は予算60ms強を超えるので落ちる",
    );

    await new Promise((r) => setTimeout(r, 10)); // cooldown(1ms) を明ける
    assert.ok(
      Array.isArray(await generateEmbedding("あ".repeat(200))),
      "200字は比例予算(460ms)で通る",
    );
  } finally {
    clearSizeEnv();
    restore();
  }
});

test("既定の予算でも短文16件は1回の送信で通る", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  delete process.env.OLLAMA_EMBED_TIMEOUT_MS;
  clearSizeEnv();
  const sent: unknown[] = [];
  captureInput(sent);
  try {
    const batch = await generateEmbeddings(Array.from({ length: 16 }, (_, i) => `投稿${i}`));
    assert.equal(batch.length, 16);
    assert.ok(batch.every((v) => Array.isArray(v)));
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
});

test("合計文字数が上限を超える送信は分け、結果は入力順に並ぶ", async () => {
  process.env.OLLAMA_EMBED_MAX_BATCH_CHARS = "10";
  const sent: unknown[] = [];
  captureInput(sent);
  // 入力ごとに違うベクトルを返して、並びが崩れていないかを見る。
  globalThis.fetch = ((_url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body.input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: body.input.map((t: string) => ({
            embedding: Array.from({ length: 1024 }, () => t.length),
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  try {
    const texts = ["aaaa", "bbbb", "cccccccccccccccc", "dd", "eee"];
    const result = await generateEmbeddings(texts);
    assert.deepEqual(sent, [
      ["aaaa", "bbbb"],
      ["cccccccccccccccc"], // 上限より長い1件は単独
      ["dd", "eee"],
    ]);
    assert.deepEqual(result.map((v) => v?.[0]), [4, 4, 16, 2, 3]);
  } finally {
    clearSizeEnv();
    restore();
  }
});

test("splitEmbeddingBatches は空入力で空を返す", () => {
  assert.deepEqual(splitEmbeddingBatches([], 10), []);
});

test("1件の入力は上限字数で切ってから送る", async () => {
  process.env.OLLAMA_EMBED_MAX_INPUT_CHARS = "5";
  const sent: unknown[] = [];
  captureInput(sent);
  try {
    await generateEmbedding("あいうえおかきくけこ");
    await generateEmbeddings(["さしすせそたちつてと", "短い"]);
    assert.deepEqual(sent, ["あいうえお", ["さしすせそ", "短い"]]);
  } finally {
    clearSizeEnv();
    restore();
  }
});

// --- cooldown の分離 ------------------------------------------------------------
// ワーカーの長文バッチが時間切れになるたび、返信前の検索まで60秒止まっていた。

const failingFetch = (calls: string[]) =>
  ((_url: unknown, init: RequestInit | undefined) => {
    calls.push(String(init?.body));
    return Promise.resolve(new Response("bad", { status: 400 }));
  }) as typeof fetch;

test("ワーカーの失敗では利用者の検索の cooldown を開かない", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  process.env.OLLAMA_EMBED_COOLDOWN_MS = "60000";
  const calls: string[] = [];
  globalThis.fetch = failingFetch(calls);
  try {
    assert.deepEqual(await generateEmbeddings(["x"], { background: true }), [null]);
    assert.equal(isEmbeddingAvailable({ background: true }), false);
    assert.equal(isEmbeddingAvailable(), true);

    const sent: unknown[] = [];
    captureInput(sent);
    assert.ok(Array.isArray(await generateEmbedding("検索")), "利用者の検索は通る");
    assert.equal(
      isEmbeddingAvailable({ background: true }),
      false,
      "利用者側の成功でワーカーの cooldown は閉じない",
    );
  } finally {
    restore();
  }
});

test("利用者の経路の失敗はワーカーも止める", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  process.env.OLLAMA_EMBED_COOLDOWN_MS = "60000";
  let now = 10_000_000;
  Date.now = () => now;
  const calls: string[] = [];
  globalThis.fetch = failingFetch(calls);
  try {
    assert.equal(await generateEmbedding("検索"), null);
    assert.equal(isEmbeddingAvailable({ background: true }), false);
    assert.deepEqual(await generateEmbeddings(["x"], { background: true }), [null]);
    assert.equal(calls.length, 1, "cooldown 中のワーカーは送らない");
  } finally {
    now += 120_000; // 後続テストへ cooldown を持ち越さない
    restore();
  }
});

test("埋め込み先が未設定なら使えない扱い（ワーカーが行を失敗として記録しない）", () => {
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_EMBED_BASE_URL;
  try {
    assert.equal(isEmbeddingAvailable({ background: true }), false);
  } finally {
    restore();
  }
});

// --- expand オプション ---------------------------------------------------------
// 別名展開は約0.8秒の LLM 生成が入る。既定で走らせると botMemory RAG（返信経路）や
// タイプアヘッドまで遅くなるので、明示的に頼まれたときだけ通ることを固定する。

test("embedSearchQuery は既定で別名展開を呼ばない", async () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.OLLAMA_EMBED_BASE_URL;
  process.env.SEARCH_QUERY_EXPANSION = "true";
  const urls: string[] = [];
  globalThis.fetch = ((url, init) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body));
    const one = Array.from({ length: 1024 }, () => 0.1);
    const count = Array.isArray(body.input) ? body.input.length : 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: Array.from({ length: count }, () => ({ embedding: one })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  try {
    await embedSearchQuery("まどマギ");
    assert.equal(
      urls.some((u) => u.includes("/api/chat")),
      false,
      "expand を指定しなければ生成経路を叩かない",
    );
    assert.deepEqual(urls, ["http://ollama.test/v1/embeddings"]);
  } finally {
    delete process.env.SEARCH_QUERY_EXPANSION;
    restore();
  }
});
