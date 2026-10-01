import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  ensureNagiBotRecordIndexed,
  getNagiAppviewInternalUrl,
} from "../src/appviewInternal.js";

const originalPort = process.env.NAGI_APPVIEW_INTERNAL_PORT;

after(() => {
  if (originalPort === undefined) delete process.env.NAGI_APPVIEW_INTERNAL_PORT;
  else process.env.NAGI_APPVIEW_INTERNAL_PORT = originalPort;
});

test("AppView内部APIは待受portと同じ設定からloopback URLを組み立てる", () => {
  process.env.NAGI_APPVIEW_INTERNAL_PORT = "3205";
  assert.equal(getNagiAppviewInternalUrl(), "http://127.0.0.1:3205");
});

test("botたんの書き込みは AppView の取り込み口へ uri と cid を渡す", async () => {
  process.env.NAGI_APPVIEW_INTERNAL_PORT = "3205";
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const record = { uri: "at://did:plc:bot/com.suibari.nagi.post/3abc", cid: "bafy" };
    assert.equal(await ensureNagiBotRecordIndexed(record), true);
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:3205/internal/bot-records/ensure", body: record },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("取り込み口が落ちていても投稿処理は止めない", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  console.warn = () => {};
  try {
    assert.equal(
      await ensureNagiBotRecordIndexed({ uri: "at://did:plc:bot/x/y", cid: "c" }),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
