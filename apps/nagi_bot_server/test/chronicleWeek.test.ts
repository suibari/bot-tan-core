import assert from "node:assert/strict";
import test from "node:test";
import {
  CHRONICLE_WEEKLY_SINCE,
  chronicleWeekEnd,
  chronicleWeekRange,
  chronicleWeekStart,
  isChronicleDate,
  isChronicleWeekClosed,
} from "../src/chronicleWeek.js";

test("chronicleWeekStart は月曜に寄せる", () => {
  assert.equal(chronicleWeekStart("2026-11-02"), "2026-11-02"); // 月
  assert.equal(chronicleWeekStart("2026-11-08"), "2026-11-02"); // 日
  assert.equal(chronicleWeekStart("2026-11-01"), "2026-10-26"); // 日
  assert.equal(chronicleWeekStart("2027-01-01"), "2026-12-28"); // 年またぎ
  assert.equal(chronicleWeekStart("2028-03-01"), "2028-02-28"); // うるう年
});

test("chronicleWeekEnd は日曜", () => {
  assert.equal(chronicleWeekEnd("2026-11-02"), "2026-11-08");
  assert.equal(chronicleWeekEnd("2026-12-28"), "2027-01-03");
});

test("週が閉じるのは日曜の翌日（cardDrawDate）から", () => {
  assert.equal(isChronicleWeekClosed("2026-11-02", "2026-11-08"), false);
  assert.equal(isChronicleWeekClosed("2026-11-02", "2026-11-09"), true);
});

test("切替日をまたぐ週は切替日から材料にする", () => {
  assert.equal(CHRONICLE_WEEKLY_SINCE, "2026-11-01");
  assert.deepEqual(chronicleWeekRange("2026-10-26"), {
    from: "2026-11-01",
    until: "2026-11-02",
  });
  assert.deepEqual(chronicleWeekRange("2026-11-02"), {
    from: "2026-11-02",
    until: "2026-11-09",
  });
});

test("isChronicleDate", () => {
  assert.equal(isChronicleDate("2026-11-02"), true);
  assert.equal(isChronicleDate("2026-11"), false);
  assert.equal(isChronicleDate("2026-13-40"), false);
});
