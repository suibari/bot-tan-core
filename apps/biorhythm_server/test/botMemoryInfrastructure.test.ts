import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  isBotMemoryAuthorized,
  serializeBotMemorySearchResult,
  validateBotMemorySearchBody,
  validateBotMemoryUsageBody,
} from "../src/botMemoryRouter.js";
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
  });
  assert.equal(count, 1);
  assert.deepEqual(saved, [1]);
});
