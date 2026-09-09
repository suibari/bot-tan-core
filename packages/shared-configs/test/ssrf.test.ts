import assert from "node:assert/strict";
import test from "node:test";
import { safeFetch } from "../src/util/ssrf.js";

test("safeFetch は signal 未指定でも既定のタイムアウトを付ける", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  };

  try {
    const response = await safeFetch("https://93.184.216.34/image.png");
    assert.equal(await response.text(), "ok");
    assert.ok(receivedSignal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safeFetch は呼び出し側が指定した signal を置き換えない", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  };

  try {
    await safeFetch("https://93.184.216.34/image.png", {
      signal: controller.signal,
    });
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
