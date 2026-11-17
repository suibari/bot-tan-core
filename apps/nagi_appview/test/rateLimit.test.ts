import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  createRateLimit,
  isEmojiReadRequest,
  viewerKey,
} from "../src/middleware/rateLimit.js";

async function withServer(
  app: express.Express,
  run: (base: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const statuses = async (url: string, times: number) => {
  const result: number[] = [];
  for (let i = 0; i < times; i++) result.push((await fetch(url)).status);
  return result;
};

test("does not count requests when rate limiting is disabled (development)", async () => {
  const app = express();
  app.get("/x", createRateLimit(false, { windowMs: 60_000, limit: 1 }), (_req, res) =>
    res.send("ok"),
  );
  await withServer(app, async (base) => {
    assert.deepEqual(await statuses(`${base}/x`, 3), [200, 200, 200]);
  });
});

test("returns 429 past the limit when enabled (production)", async () => {
  const app = express();
  app.get("/x", createRateLimit(true, { windowMs: 60_000, limit: 1 }), (_req, res) =>
    res.send("ok"),
  );
  await withServer(app, async (base) => {
    assert.deepEqual(await statuses(`${base}/x`, 2), [200, 429]);
  });
});

test("emoji reads use their own bucket and do not exhaust the general xrpc limit", async () => {
  const app = express();
  app.use(
    "/xrpc",
    createRateLimit(true, {
      windowMs: 60_000,
      limit: 5,
      keyGenerator: viewerKey,
      skip: (req) => !isEmojiReadRequest(req),
    }),
    createRateLimit(true, {
      windowMs: 60_000,
      limit: 1,
      keyGenerator: viewerKey,
      skip: (req) => isEmojiReadRequest(req),
    }),
    (_req, res) => res.send("ok"),
  );
  await withServer(app, async (base) => {
    const getEmoji = `${base}/xrpc/${NAGI.getEmoji}?uri=x`;
    assert.deepEqual(await statuses(getEmoji, 3), [200, 200, 200]);
    // 絵文字を何度引いても、タイムラインの枠はまだ残っている。
    assert.equal((await fetch(`${base}/xrpc/${NAGI.getTimeline}`)).status, 200);
    assert.equal((await fetch(`${base}/xrpc/${NAGI.getTimeline}`)).status, 429);
    // 絵文字側は自分の枠を使い切るまで通る。
    assert.deepEqual(await statuses(getEmoji, 3), [200, 200, 429]);
  });
});

test("semantic emoji search stays in the general bucket because it calls Ollama", () => {
  const path = `/${NAGI.searchEmojis}`;
  assert.equal(isEmojiReadRequest({ path, query: {} }), true);
  assert.equal(isEmojiReadRequest({ path, query: { semantic: "false" } }), true);
  assert.equal(isEmojiReadRequest({ path, query: { semantic: "true" } }), false);
  assert.equal(isEmojiReadRequest({ path: `/${NAGI.getEmoji}`, query: {} }), true);
  assert.equal(
    isEmojiReadRequest({ path: `/${NAGI.createEmojiGeneration}`, query: {} }),
    false,
  );
});
