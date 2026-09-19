import assert from "node:assert/strict";
import test from "node:test";
import { startZenkatsuComment } from "../src/services/zenkatsuComment.js";

test("即時生成を通知し、通知失敗を提出側へ伝播しない", async (t) => {
  const uri = "at://did:plc:test/com.suibari.nagi.zenkatsu/2026-09-19";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith("/zenkatsu/run"));
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { submissionUri: uri });
    assert.ok(init.signal);
    calls++;
    if (calls === 2) return new Response("", { status: 503 });
    if (calls === 3) throw new Error("connection refused");
    return new Response("", { status: 202 });
  });
  t.mock.method(console, "warn", () => {});
  await startZenkatsuComment(uri);
  await startZenkatsuComment(uri);
  await startZenkatsuComment(uri);
  assert.equal(calls, 3);
});
