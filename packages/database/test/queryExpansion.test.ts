import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAliasRequestBody,
  expandSearchQuery,
  filterAliases,
  queryExpansionEnabled,
  resetQueryExpansionState,
} from "../src/queryExpansion.js";

const original = {
  baseUrl: process.env.OLLAMA_BASE_URL,
  enabled: process.env.SEARCH_QUERY_EXPANSION,
  maxLen: process.env.SEARCH_QUERY_EXPANSION_MAX_LEN,
  cooldown: process.env.SEARCH_QUERY_EXPANSION_COOLDOWN_MS,
  timeout: process.env.SEARCH_QUERY_EXPANSION_TIMEOUT_MS,
  fetch: globalThis.fetch,
};

const restore = () => {
  for (const [key, value] of [
    ["OLLAMA_BASE_URL", original.baseUrl],
    ["SEARCH_QUERY_EXPANSION", original.enabled],
    ["SEARCH_QUERY_EXPANSION_MAX_LEN", original.maxLen],
    ["SEARCH_QUERY_EXPANSION_COOLDOWN_MS", original.cooldown],
    ["SEARCH_QUERY_EXPANSION_TIMEOUT_MS", original.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = original.fetch;
  resetQueryExpansionState();
};

/** aliases を返す fetch。送られたリクエスト本体を sink に記録する。 */
const stubAliases = (aliases: unknown, sink: any[] = []) => {
  globalThis.fetch = ((_url, init) => {
    sink.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: JSON.stringify({ aliases }) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return sink;
};

// --- リクエスト本体 -----------------------------------------------------------

test("別名展開のリクエストに num_ctx が含まれない", () => {
  const body = buildAliasRequestBody("m", "p", 256);
  // options に無いだけでなく本体のどこにも現れないこと。送ると同じモデルでも
  // runner が作り直され、同居アプリごと巻き込む（AGENTS.md）。
  assert.equal(/num_ctx/.test(JSON.stringify(body)), false);
  assert.equal("num_ctx" in body.options, false);
});

test("num_predict を必ず送り、think を切る", () => {
  const body = buildAliasRequestBody("m", "p", 256);
  // num_predict を省くと Ollama 既定の -1 になり、エラーにならず空応答が返る。
  assert.equal(body.options.num_predict, 256);
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.format.required, ["aliases"]);
});

// --- 別名の絞り込み -----------------------------------------------------------

test("元のクエリを含む別名は捨てる", () => {
  // 「ウマ娘」→「ウマ娘 プリティーダービー」のような語尾追加。プロンプトでも禁じているが
  // すり抜けたので、コード側で確実に落とす。
  assert.deepEqual(filterAliases("ウマ娘", ["ウマ娘 プリティーダービー", "競走馬育成"]), [
    "競走馬育成",
  ]);
});

test("空・重複・元クエリと同一を捨て、3件までに絞る", () => {
  assert.deepEqual(
    filterAliases("まどマギ", ["", "  ", "まどマギ", "魔法少女まどか☆マギカ", "魔法少女まどか☆マギカ"]),
    ["魔法少女まどか☆マギカ"],
  );
  assert.deepEqual(filterAliases("x", ["a", "b", "c", "d"]), ["a", "b", "c"]);
});

test("配列でない応答は空扱いにする", () => {
  assert.deepEqual(filterAliases("q", null), []);
  assert.deepEqual(filterAliases("q", "まどか"), []);
});

// --- 展開の本体 ---------------------------------------------------------------

test("既定では無効で、クエリを素通しする", async () => {
  delete process.env.SEARCH_QUERY_EXPANSION;
  const sent = stubAliases(["魔法少女まどか☆マギカ"]);
  try {
    assert.equal(queryExpansionEnabled(), false);
    assert.equal(await expandSearchQuery("まどマギ"), "まどマギ");
    assert.deepEqual(sent, [], "無効なら Ollama を呼ばない");
  } finally {
    restore();
  }
});

test("有効なら別名を足したクエリを返す", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  stubAliases(["魔法少女まどか☆マギカ"]);
  try {
    assert.equal(await expandSearchQuery("まどマギ"), "まどマギ 魔法少女まどか☆マギカ");
  } finally {
    restore();
  }
});

test("別名が空なら元のクエリをそのまま返す", async () => {
  // 「知らない語は触らない」。これがあるから一般語を悪化させようがない。
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  stubAliases([]);
  try {
    assert.equal(await expandSearchQuery("散歩"), "散歩");
  } finally {
    restore();
  }
});

test("ネイティブ /api/chat を叩く（OpenAI 互換だと think を切れない）", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  const urls: string[] = [];
  globalThis.fetch = ((url) => {
    urls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify({ message: { content: JSON.stringify({ aliases: [] }) } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    await expandSearchQuery("まどマギ");
    assert.deepEqual(urls, ["http://ollama.test/api/chat"]);
  } finally {
    restore();
  }
});

test("長すぎるクエリは展開しない", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  process.env.SEARCH_QUERY_EXPANSION_MAX_LEN = "10";
  const sent = stubAliases(["なにか"]);
  try {
    const long = "あ".repeat(11);
    assert.equal(await expandSearchQuery(long), long);
    assert.deepEqual(sent, [], "長文は検索語ではないので呼ばない");
  } finally {
    restore();
  }
});

test("同じクエリは2回目以降キャッシュから返す", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  const sent = stubAliases(["魔法少女まどか☆マギカ"]);
  try {
    await expandSearchQuery("まどマギ");
    await expandSearchQuery("まどマギ");
    assert.equal(sent.length, 1, "検索語は繰り返されるので生成は1回で足りる");
  } finally {
    restore();
  }
});

test("生成に失敗しても検索を止めず、元のクエリを返す", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  process.env.SEARCH_QUERY_EXPANSION_COOLDOWN_MS = "10000";
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response("boom", { status: 500 }));
  }) as typeof fetch;
  try {
    assert.equal(await expandSearchQuery("まどマギ"), "まどマギ");
    // 失敗後はクールダウン中なので叩き直さない。
    assert.equal(await expandSearchQuery("ブルアカ"), "ブルアカ");
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("OLLAMA_BASE_URL 未設定でも落ちない", async () => {
  process.env.SEARCH_QUERY_EXPANSION = "true";
  delete process.env.OLLAMA_BASE_URL;
  try {
    assert.equal(await expandSearchQuery("まどマギ"), "まどマギ");
  } finally {
    restore();
  }
});
