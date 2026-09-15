import assert from "node:assert/strict";
import test from "node:test";
import {
  drawingDay,
  drawingServiceDailyLimit,
  hasDrawingUserDailyLimit,
} from "../src/drawingClaims.js";

test("お絵描きの1日は JST の暦日で区切る", () => {
  assert.equal(drawingDay(new Date("2026-09-13T14:59:59.999Z")), "2026-09-13");
  assert.equal(drawingDay(new Date("2026-09-13T15:00:00.000Z")), "2026-09-14");
});

test("サービス枠は未設定なら既定値、0 なら機能を止める", () => {
  assert.equal(drawingServiceDailyLimit(undefined), 30);
  assert.equal(drawingServiceDailyLimit(""), 30);
  assert.equal(drawingServiceDailyLimit("0"), 0);
  assert.equal(drawingServiceDailyLimit("5"), 5);
});

test("壊れたサービス枠の値では throw せず既定値に倒す", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const raw of ["-1", "1.5", "abc"]) {
      assert.equal(drawingServiceDailyLimit(raw), 30, `${raw} が既定値にならない`);
    }
  } finally {
    console.warn = warn;
  }
});

test("本人からの依頼は無制限で、Nagi の自動プレゼントだけを1日1枚にする", () => {
  assert.equal(hasDrawingUserDailyLimit("request"), false);
  assert.equal(hasDrawingUserDailyLimit("gift"), true);
});
