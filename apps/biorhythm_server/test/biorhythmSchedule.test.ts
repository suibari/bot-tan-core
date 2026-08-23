import assert from "node:assert/strict";
import test from "node:test";
import {
  getNextStepTime,
  getStartupStepDelayMs,
  resolveStartupStepSchedule,
} from "../src/biorhythmSchedule.js";

test("再起動が次回予定より前なら、その予定時刻まで待つ", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.equal(
    getStartupStepDelayMs("2026-08-23T00:45:00.000Z", now),
    45 * 60 * 1000,
  );
});

test("予定時刻を過ぎていた場合は、その場で未実行分を開始する", () => {
  const now = Date.parse("2026-08-23T01:00:00.000Z");
  assert.equal(getStartupStepDelayMs("2026-08-23T00:45:00.000Z", now), 0);
});

test("保存時刻がない旧状態ではデプロイ時に更新せず1時間後を初回予定にする", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.deepEqual(resolveStartupStepSchedule(undefined, now), {
    nextStepTime: "2026-08-23T01:00:00.000Z",
    delayMs: 60 * 60 * 1000,
    needsPersistence: true,
  });
});

test("次回時刻はstep完了時に決まった間隔から作る", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.equal(
    getNextStepTime(90 * 60 * 1000, now),
    "2026-08-23T01:30:00.000Z",
  );
});
