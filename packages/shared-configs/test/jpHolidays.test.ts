import assert from "node:assert/strict";
import test from "node:test";
import { getJapaneseHolidayName, isJapaneseDayOff } from "../src/util/jpHolidays.js";

const name = (iso: string) => {
  const [year, month, date] = iso.split("-").map(Number);
  return getJapaneseHolidayName(year, month, date);
};
const dayOff = (iso: string) => {
  const [year, month, date] = iso.split("-").map(Number);
  return isJapaneseDayOff(year, month, date);
};

test("固定日・ハッピーマンデー・春分秋分を祝日にする", () => {
  assert.equal(name("2026-01-01"), "元日");
  assert.equal(name("2026-01-12"), "成人の日");
  assert.equal(name("2026-03-20"), "春分の日");
  assert.equal(name("2026-07-20"), "海の日");
  assert.equal(name("2026-09-21"), "敬老の日");
  assert.equal(name("2026-09-23"), "秋分の日");
  assert.equal(name("2026-10-12"), "スポーツの日");
  assert.equal(name("2026-11-23"), "勤労感謝の日");
});

test("日曜の祝日の翌日は振替休日", () => {
  // 2026-05-03（憲法記念日）は日曜。5/4・5/5 も祝日なので、振替は 5/6 まで押し出される。
  assert.equal(name("2026-05-06"), "振替休日");
  // 2027 年は 5/3 が月曜で日曜の祝日が無いので、5/6 は平日のまま。
  assert.equal(name("2027-05-06"), undefined);
  // 2027-03-21（春分の日）は日曜 → 3/22 が振替。
  assert.equal(name("2027-03-22"), "振替休日");
});

test("祝日に挟まれた平日は国民の休日", () => {
  assert.equal(name("2026-09-22"), "国民の休日");
});

test("祝日でない平日は undefined、土日は休日", () => {
  assert.equal(name("2026-09-29"), undefined);
  assert.equal(dayOff("2026-09-29"), false);
  assert.equal(dayOff("2026-09-26"), true);
  assert.equal(dayOff("2026-09-27"), true);
  assert.equal(dayOff("2026-09-21"), true);
});
