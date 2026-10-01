import assert from "node:assert/strict";
import test from "node:test";
import { JetstreamLagWatch } from "../src/ingest/jetstreamLag.js";

const BOT = "did:plc:bot";
const URI = `at://${BOT}/com.suibari.nagi.post/3abc`;
const commit = (cid: string, did = BOT, operation = "create") => ({
  did,
  time_us: 1,
  commit: { collection: "com.suibari.nagi.post", rkey: "3abc", cid, operation },
});

const watch = (clock: { now: number }, maxStrikes = 2) =>
  new JetstreamLagWatch({
    botDid: BOT,
    stallAfterMs: 5 * 60_000,
    maxStrikes,
    now: () => clock.now,
  });

test("届いた書き込みは遅延として残らず、到着までの時間を記録する", () => {
  const clock = { now: 0 };
  const lag = watch(clock);
  lag.expect(URI, "cid1");
  clock.now = 2_000;
  lag.observe(commit("cid1"));
  assert.equal(lag.isLagging(), false);
  assert.equal(lag.snapshot().pendingBotWrites, 0);
  assert.equal(lag.snapshot().lastBotWriteLagMs, 2_000);
});

test("期限を過ぎても届かない書き込みを遅延として返す", () => {
  const clock = { now: 0 };
  const lag = watch(clock);
  lag.expect(URI, "cid1");
  clock.now = 4 * 60_000;
  assert.deepEqual(lag.overdue(), []);
  assert.equal(lag.isLagging(), false);
  clock.now = 6 * 60_000;
  assert.equal(lag.overdue().length, 1);
  assert.equal(lag.isLagging(), true);
});

test("別の版（cid違い）が届いても目印は消えない", () => {
  const clock = { now: 0 };
  const lag = watch(clock);
  lag.expect(URI, "cid2");
  lag.observe(commit("cid1"));
  assert.equal(lag.snapshot().pendingBotWrites, 1);
});

test("取り込み依頼より先に Jetstream が届いていたら待たない", () => {
  const clock = { now: 0 };
  const lag = watch(clock);
  lag.observe(commit("cid1"));
  lag.expect(URI, "cid1");
  assert.equal(lag.snapshot().pendingBotWrites, 0);
});

test("他人のイベントは先着として覚えない", () => {
  const clock = { now: 0 };
  const lag = watch(clock);
  lag.observe(commit("cid1", "did:plc:other"));
  lag.expect(URI, "cid1");
  assert.equal(lag.snapshot().pendingBotWrites, 1);
});

test("切り替え後は期限を延ばし、届くまで遅延のまま扱う", () => {
  const clock = { now: 0 };
  const lag = watch(clock, 3);
  lag.expect(URI, "cid1");
  clock.now = 6 * 60_000;
  assert.deepEqual(lag.markStalled(), []);
  // 期限は延びたが、まだ届いていないので解消扱いにしない。
  assert.deepEqual(lag.overdue(), []);
  assert.equal(lag.isLagging(), true);
  lag.observe(commit("cid1"));
  assert.equal(lag.isLagging(), false);
});

test("全候補を試しても届かない目印は諦める", () => {
  const clock = { now: 0 };
  const lag = watch(clock, 2);
  lag.expect(URI, "cid1");
  clock.now = 6 * 60_000;
  assert.deepEqual(lag.markStalled(), []);
  clock.now = 12 * 60_000;
  assert.deepEqual(lag.markStalled(), [URI]);
  assert.equal(lag.isLagging(), false);
});
