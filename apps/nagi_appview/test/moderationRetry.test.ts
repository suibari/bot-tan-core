import assert from "node:assert/strict";
import test from "node:test";
import {
  ModerationRetryLedger,
  MODERATION_MAX_RETRIES,
  MODERATION_RETRY_DELAYS_MS,
  moderationRetryKey,
} from "../src/ingest/moderationRetry.js";

const KEY = moderationRetryKey("at://did:plc:a/com.suibari.nagi.post/x", "cid1");

test("retry spacing is 30s, 1m, 2m, 4m, 8m", () => {
  assert.deepEqual(
    [...MODERATION_RETRY_DELAYS_MS],
    [30_000, 60_000, 120_000, 240_000, 480_000],
  );
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  for (const [index, expected] of MODERATION_RETRY_DELAYS_MS.entries()) {
    const state = ledger.record(KEY, now);
    assert.equal(state.failures, index + 1);
    assert.equal(state.exhausted, false);
    assert.equal(state.nextAttemptAt - now, expected);
  }
});

test("the budget is exhausted after the configured number of retries", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  for (let i = 0; i < MODERATION_MAX_RETRIES; i++)
    assert.equal(ledger.record(KEY, now).exhausted, false);
  const final = ledger.record(KEY, now);
  assert.equal(final.exhausted, true);
  assert.equal(final.failures, MODERATION_MAX_RETRIES + 1);
  // 合計およそ15分半。ここが縮むと一時障害を拾いきれなくなる。
  const total = MODERATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.equal(total, 930_000);
});

test("an item with no history is always ready", () => {
  const ledger = new ModerationRetryLedger();
  assert.equal(ledger.ready(KEY, 0), true);
});

test("a deferred item is not ready until its next attempt time", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  ledger.record(KEY, now);
  assert.equal(ledger.ready(KEY, now + 29_999), false);
  assert.equal(ledger.ready(KEY, now + 30_000), true);
});

test("a successful judgement resets the budget", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  ledger.record(KEY, now);
  ledger.record(KEY, now);
  ledger.clear(KEY);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.record(KEY, now).failures, 1);
});

test("exhausting an item removes it from the ledger", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  for (let i = 0; i <= MODERATION_MAX_RETRIES; i++) ledger.record(KEY, now);
  assert.equal(ledger.size, 0);
});

test("editing the record starts a fresh budget", () => {
  const uri = "at://did:plc:a/com.suibari.nagi.post/x";
  assert.notEqual(moderationRetryKey(uri, "cid1"), moderationRetryKey(uri, "cid2"));
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  ledger.record(moderationRetryKey(uri, "cid1"), now);
  assert.equal(ledger.ready(moderationRetryKey(uri, "cid2"), now), true);
});

test("earliestDeferredAt returns the soonest pending retry", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  const slow = moderationRetryKey("at://did:plc:a/c/slow", "cid");
  ledger.record(KEY, now);
  ledger.record(slow, now);
  ledger.record(slow, now); // 2回目なので 60s 先
  assert.equal(ledger.earliestDeferredAt(now), now + 30_000);
  assert.equal(ledger.earliestDeferredAt(now + 120_000), undefined);
});

test("stale entries are pruned so the ledger cannot grow without bound", () => {
  const ledger = new ModerationRetryLedger();
  const now = 1_000_000;
  ledger.record(KEY, now);
  assert.equal(ledger.size, 1);
  ledger.prune(now + 2 * 60 * 60_000);
  assert.equal(ledger.size, 0);

  for (let i = 0; i < 2_500; i++)
    ledger.record(moderationRetryKey(`at://did:plc:a/c/${i}`, "cid"), now + i);
  assert.ok(ledger.size <= 2_000, `ledger grew to ${ledger.size}`);
});
