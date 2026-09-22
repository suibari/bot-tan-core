import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientRebuildScheduler,
  DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS,
  parseClientRebuildMinIntervalMs,
} from "../src/services/clientRebuildScheduler.js";

test("uses a safe default and rejects dangerously short rebuild intervals", () => {
  assert.equal(
    parseClientRebuildMinIntervalMs(""),
    DEFAULT_CLIENT_REBUILD_MIN_INTERVAL_MS,
  );
  assert.equal(parseClientRebuildMinIntervalMs("3600000"), 3_600_000);
  assert.throws(
    () => parseClientRebuildMinIntervalMs("1799999"),
    /at least 1800000/,
  );
  assert.throws(() => parseClientRebuildMinIntervalMs("nope"), /integer/);
});

test("requests immediately and coalesces a burst into one trailing rebuild", async () => {
  let now = 1_000;
  const reasons: string[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const scheduler = new ClientRebuildScheduler({
    minIntervalMs: 10_000,
    now: () => now,
    request: async (reason) => {
      reasons.push(reason);
      return true;
    },
    setTimer: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
  });

  assert.equal(await scheduler.notify("article=first"), "requested");
  now = 2_000;
  assert.equal(await scheduler.notify("article=second"), "coalesced");
  now = 3_000;
  assert.equal(await scheduler.notify("article=third"), "coalesced");

  assert.deepEqual(reasons, ["article=first"]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 9_000);

  now = 11_000;
  timers[0].callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(reasons, [
    "article=first",
    "article=third; coalesced_changes=2",
  ]);
});

test("reserves the cooldown before the immediate request finishes", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const scheduler = new ClientRebuildScheduler({
    minIntervalMs: 10_000,
    now: () => 1_000,
    request: async () => {
      calls += 1;
      if (calls === 1) await firstRequest;
      return true;
    },
    setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
  });

  const immediate = scheduler.notify("article=first");
  assert.equal(await scheduler.notify("article=second"), "coalesced");
  assert.equal(calls, 1);
  releaseFirst?.();
  assert.equal(await immediate, "requested");
});
