import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startWorkerLoop } from "../src/workerLoop.js";

test("前の tick が終わるまで次を起こさない", async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const timer = startWorkerLoop({
    name: "TEST",
    intervalMs: 5,
    tick: async () => { started++; await gate; },
  });
  try {
    // 間隔の何倍も待つ。素の setInterval なら本数が積み上がる。
    await delay(60);
    assert.equal(started, 1);
    release();
    // 完了後は次の tick が回る。
    await delay(30);
    assert.ok(started > 1, `expected the loop to resume, got ${started}`);
  } finally {
    clearInterval(timer);
    release();
  }
});

test("tick が投げてもループは止まらない", async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  let calls = 0;
  const timer = startWorkerLoop({
    name: "TEST",
    intervalMs: 5,
    tick: async () => { calls++; throw new Error("boom"); },
  });
  try {
    await delay(40);
    assert.ok(calls > 1, `expected repeated ticks, got ${calls}`);
    assert.ok(errors.length > 0);
  } finally {
    clearInterval(timer);
    console.error = originalError;
  }
});

test("immediate は最初の間隔を待たずに一度回す", async () => {
  let calls = 0;
  const timer = startWorkerLoop({
    name: "TEST",
    intervalMs: 60_000,
    tick: async () => { calls++; },
    immediate: true,
  });
  try {
    await delay(10);
    assert.equal(calls, 1);
  } finally {
    clearInterval(timer);
  }
});
