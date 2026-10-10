import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  isBotMemoryAuthorized,
  serializeBotMemorySearchResult,
  serializeMemoryContext,
  validateBotMemoryContextBody,
  validateBotMemorySearchBody,
  validateBotMemoryUsageBody,
} from "../src/botMemoryRouter.js";
import { createEmbeddingRetryBackoff } from "@bsky-affirmative-bot/database";
import { processBotMemoryEmbeddingBatch } from "../src/botMemoryEmbeddingWorker.js";
import {
  createBotMemoryInternalApp,
  readBotMemoryInternalServerConfig,
} from "../src/botMemoryInternalServer.js";

async function listen(app: ReturnType<typeof createBotMemoryInternalApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to listen");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test("internal memory auth requires exact bearer secret", () => {
  assert.equal(isBotMemoryAuthorized("Bearer secret", "secret"), true);
  assert.equal(isBotMemoryAuthorized("Bearer wrong", "secret"), false);
  assert.equal(isBotMemoryAuthorized(undefined, "secret"), false);
  assert.equal(isBotMemoryAuthorized("Bearer secret", undefined), false);
});

test("memory API has an independent loopback listener by default", () => {
  assert.deepEqual(readBotMemoryInternalServerConfig({}), {
    host: "127.0.0.1",
    port: 3003,
  });
  assert.deepEqual(readBotMemoryInternalServerConfig({
    BIORHYTHM_MEMORY_API_HOST: "192.168.1.200",
    BIORHYTHM_MEMORY_API_PORT: "3201",
  }), {
    host: "192.168.1.200",
    port: 3201,
  });
  assert.throws(
    () => readBotMemoryInternalServerConfig({ BIORHYTHM_MEMORY_API_PORT: "0" }),
    /between 1 and 65535/,
  );
});

test("dedicated memory app fails closed when its secret is missing", async (t) => {
  const { server, url } = await listen(createBotMemoryInternalApp(undefined));
  t.after(() => server.close());

  const response = await fetch(`${url}/memory/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "test", purpose: "live_filler" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "server not configured" });
});

test("internal API response does not expose author or source identifiers", () => {
  const serialized = serializeBotMemorySearchResult({
    id: 1,
    sourceType: "nagi_received_reply",
    sourceId: "private-source-id",
    sourceUri: "at://did:plc:author/com.suibari.nagi.post/one",
    authorId: "did:plc:author",
    content: "本文",
    botResponse: null,
    occurredAt: new Date("2026-08-21T00:00:00Z"),
    affirmationScore: null,
    metadata: { safe: true },
    relevance: 0.1,
  });
  assert.deepEqual(Object.keys(serialized), [
    "id", "source", "content", "occurredAt", "metadata", "relevance",
  ]);
  assert.equal(serialized.source, "nagi_received_reply");
});

test("search body validates purpose, sources, and query length", () => {
  assert.deepEqual(validateBotMemorySearchBody({
    query: "  今日の挑戦  ",
    purpose: "live_filler",
    sources: ["nagi_affirmed_post"],
  }), {
    query: "今日の挑戦",
    purpose: "live_filler",
    sources: ["nagi_affirmed_post"],
  });
  assert.deepEqual(validateBotMemorySearchBody({
    query: "Blueskyで前に何があった？",
    purpose: "live_reply",
    sources: ["bsky_received_reply", "bsky_received_like"],
  }), {
    query: "Blueskyで前に何があった？",
    purpose: "live_reply",
    sources: ["bsky_received_reply", "bsky_received_like"],
  });
  assert.throws(() => validateBotMemorySearchBody({ query: "", purpose: "live_filler" }));
  assert.throws(() => validateBotMemorySearchBody({ query: "ok", purpose: "unknown" }));
  assert.throws(() => validateBotMemorySearchBody({
    query: "ok",
    purpose: "live_filler",
    sources: ["kossori"],
  }));
});

test("usage body accepts live_reply and keeps its existing limits", () => {
  assert.deepEqual(validateBotMemoryUsageBody({
    purpose: "live_reply",
    documentIds: [1, 1, "bad", ...Array.from({ length: 25 }, (_, i) => i + 2)],
    outputRef: "broadcast-1",
  }), {
    purpose: "live_reply",
    documentIds: Array.from({ length: 20 }, (_, i) => i + 1),
    outputRef: "broadcast-1",
  });
  assert.throws(() => validateBotMemoryUsageBody({
    purpose: "unknown",
    documentIds: [1],
  }));
});

test("embedding batch saves successful rows and leaves failed rows pending", async () => {
  const saved: number[] = [];
  const count = await processBotMemoryEmbeddingBatch({
    fetchPending: async () => [
      { id: 1, content: "first", contentHash: "a" },
      { id: 2, content: "second", contentHash: "b" },
    ],
    embed: async () => [Array(1024).fill(0.1), null],
    save: async (id) => {
      saved.push(id);
      return true;
    },
    available: () => true,
    backoff: createEmbeddingRetryBackoff(),
  });
  assert.equal(count, 1);
  assert.deepEqual(saved, [1]);
});

test("embedding batch skips rows that failed recently and moves on to later rows", async () => {
  // 失敗した組を次の回も選び直すと、時間切れ → cooldown → 同じ組で時間切れ を繰り返す。
  let now = 0;
  const backoff = createEmbeddingRetryBackoff({ baseMs: 1_000, now: () => now });
  const rows = [
    { id: 1, content: "長い調査メモ".repeat(300), contentHash: "a" },
    { id: 2, content: "short", contentHash: "b" },
  ];
  const sentIds: number[][] = [];
  const limits: number[] = [];
  const saved = new Set<number>();
  const run = () => processBotMemoryEmbeddingBatch({
    fetchPending: async (limit) => {
      limits.push(limit ?? 0);
      return rows.filter((r) => !saved.has(r.id));
    },
    embed: async (texts, opts) => {
      assert.deepEqual(opts, { background: true }, "ワーカーの失敗で利用者の検索を止めない");
      sentIds.push(texts.map((t) => rows.find((r) => r.content === t)!.id));
      return texts.map((t) => (t === rows[0].content ? null : Array(1024).fill(0.1)));
    },
    save: async (id) => {
      saved.add(id);
      return true;
    },
    available: () => true,
    backoff,
  });

  assert.equal(await run(), 1);
  assert.equal(await run(), 0);
  assert.deepEqual(sentIds, [[1, 2]], "失敗した行は待ちのあいだ選ばれない");
  assert.equal(limits[1], 17, "待たせている行の分だけ多めに取る");

  now += 1_001;
  await run();
  assert.deepEqual(sentIds.at(-1), [1], "待ちが明ければ再挑戦する");
});

test("embedding batch does not pick rows while the embedding server is cooling down", async () => {
  const backoff = createEmbeddingRetryBackoff();
  let fetched = false;
  const count = await processBotMemoryEmbeddingBatch({
    fetchPending: async () => {
      fetched = true;
      return [{ id: 1, content: "x", contentHash: "a" }];
    },
    embed: async () => [null],
    save: async () => true,
    available: () => false,
    backoff,
  });
  assert.equal(count, 0);
  assert.equal(fetched, false);
  assert.equal(backoff.size(), 0, "送っていない行を失敗として記録しない");
});

test("context body accepts the subject weighting and rejects out-of-range values", () => {
  assert.deepEqual(validateBotMemoryContextBody({
    query: "  前に話したこと  ",
    purpose: "live_reply",
    subjectKey: " youtube:UC123 ",
    subjectWeight: 3,
    digestDays: 5,
    limit: 8,
  }), {
    query: "前に話したこと",
    purpose: "live_reply",
    sources: undefined,
    subjectKey: "youtube:UC123",
    subjectWeight: 3,
    digestDays: 5,
    limit: 8,
    researchLimit: undefined,
    excludeDocumentIds: undefined,
  });
  // query 無しでも短期記憶だけは取れる（検索を通さない層なので）。
  assert.equal(validateBotMemoryContextBody({ purpose: "live_filler" }).query, "");
  assert.throws(() => validateBotMemoryContextBody({ purpose: "unknown" }));
  assert.throws(() => validateBotMemoryContextBody({
    purpose: "live_filler",
    subjectWeight: 0,
  }));
  assert.throws(() => validateBotMemoryContextBody({
    purpose: "live_filler",
    digestDays: -1,
  }));
  assert.throws(() => validateBotMemoryContextBody({
    purpose: "live_filler",
    sources: ["kossori"],
  }));
});

test("context response does not expose author or source identifiers", () => {
  const memory = {
    id: 1,
    sourceType: "nagi_affirmed_post" as const,
    sourceId: "private-source-id",
    sourceUri: "at://did:plc:author/com.suibari.nagi.post/one",
    authorId: "did:plc:author",
    content: "本文",
    botResponse: null,
    occurredAt: new Date("2026-08-21T00:00:00Z"),
    affirmationScore: null,
    metadata: null,
    relevance: 0.1,
  };
  const serialized = serializeMemoryContext({
    recent: [{
      digestDate: "2026-08-20",
      summaryJa: "しずかな一日だった。",
      highlights: [{ documentId: 42, excerpt: "抜粋", surface: "nagi" }],
      sourceCount: 3,
    }],
    own: [memory],
    related: [memory],
    friend: memory,
    research: [],
  });
  const flat = JSON.stringify(serialized);
  assert.doesNotMatch(flat, /did:plc:author/);
  assert.doesNotMatch(flat, /private-source-id/);
  assert.doesNotMatch(flat, /at:\/\//);
  // 内部の documentId もハイライトから落とす。
  assert.deepEqual(serialized.recent[0].highlights, [
    { excerpt: "抜粋", surface: "nagi" },
  ]);
  assert.deepEqual(Object.keys(serialized), ["recent", "related", "friend", "research"]);
});

test("presence endpoint requires auth and returns only the agreed fields", async (t) => {
  const presence = {
    status: "FreeTime" as const,
    energy: 17.1,
    mood: "全肯定たんは、雑貨屋をのぞいています。",
    moodEn: "Bot-tan is browsing a shop.",
    weather: "快晴",
    nextStepTime: "2026-10-10T05:00:00.000Z",
    internalOnly: "must not leak",
  };
  const { server, url } = await listen(createBotMemoryInternalApp("secret", {
    getPresence: () => presence,
  }));
  t.after(() => server.close());

  const unauthorized = await fetch(`${url}/bot/presence`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${url}/bot/presence`, { headers: { authorization: "Bearer secret" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "FreeTime",
    energy: 17.1,
    mood: "全肯定たんは、雑貨屋をのぞいています。",
    moodEn: "Bot-tan is browsing a shop.",
    weather: "快晴",
    nextStepTime: "2026-10-10T05:00:00.000Z",
  });
});

test("presence endpoint is unavailable when no source is wired", async (t) => {
  const { server, url } = await listen(createBotMemoryInternalApp("secret"));
  t.after(() => server.close());
  const response = await fetch(`${url}/bot/presence`, { headers: { authorization: "Bearer secret" } });
  assert.equal(response.status, 503);
});
