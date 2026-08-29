import assert from "node:assert/strict";
import test from "node:test";
import {
  formatJstActivityTime,
  getFullDateAndTimeString,
  getWhatDayForCalendarDate,
} from "../src/util/common.js";

const now = new Date("2026-08-10T05:00:00Z"); // JST 8/10 14:00

test("UTCのISO入力をJSTの壁時計と相対時間で出す", () => {
  assert.equal(
    formatJstActivityTime("2026-08-10T02:05:00Z", now, true),
    "今日 11:05（2時間前）",
  );
  assert.equal(
    formatJstActivityTime("2026-08-10T02:05:00Z", now, false),
    "Today 11:05 (2h ago)",
  );
});

test("日をまたぐと昨日・N日前になる", () => {
  // JST 8/9 23:40
  assert.equal(
    formatJstActivityTime("2026-08-09T14:40:00Z", now, true),
    "昨日 23:40（14時間前）",
  );
  // JST 8/8 10:00
  assert.equal(
    formatJstActivityTime("2026-08-08T01:00:00Z", now, true),
    "8月8日 10:00（2日前）",
  );
  assert.equal(
    formatJstActivityTime("2026-08-08T01:00:00Z", now, false),
    "8/8 10:00 (2d ago)",
  );
});

test("1分未満と1時間未満の刻み", () => {
  assert.equal(
    formatJstActivityTime("2026-08-10T04:59:30Z", now, true),
    "今日 13:59（たった今）",
  );
  assert.equal(
    formatJstActivityTime("2026-08-10T04:20:00Z", now, true),
    "今日 13:20（40分前）",
  );
});

test("未来の時刻でも負の相対時間を出さない", () => {
  assert.equal(
    formatJstActivityTime("2026-08-10T06:00:00Z", now, true),
    "今日 15:00（たった今）",
  );
});

test("パースできない入力はそのまま返す（履歴1件で全体を壊さない）", () => {
  assert.equal(formatJstActivityTime("not-a-date", now, true), "not-a-date");
});

test("サーバーのタイムゾーンに依存しない", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const asUtc = formatJstActivityTime("2026-08-10T02:05:00Z", now, true);
    process.env.TZ = "Asia/Tokyo";
    const asJst = formatJstActivityTime("2026-08-10T02:05:00Z", now, true);
    assert.equal(asUtc, asJst);
    assert.equal(asUtc, "今日 11:05（2時間前）");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("現在日時はJSTの曜日を明示し、サーバーのタイムゾーンに依存しない", () => {
  // UTCでは8/28だが、JSTでは土曜日の8/29。
  assert.equal(
    getFullDateAndTimeString(new Date("2026-08-28T15:30:00Z")),
    "2026年8月29日（土曜日）0時30分",
  );
});

test("プレミアムフライデーは対象年の月末金曜日だけに加える", () => {
  assert.equal(
    getWhatDayForCalendarDate(2025, 8, 29).includes("プレミアムフライデー"),
    true,
  );
  assert.equal(
    getWhatDayForCalendarDate(2026, 8, 29).includes("プレミアムフライデー"),
    false,
  );
  assert.equal(
    getWhatDayForCalendarDate(2026, 8, 28).includes("プレミアムフライデー"),
    true,
  );
});

test("11月の曜日依存記念日はそれぞれの規則で年ごとに判定する", () => {
  const greenFriday = getWhatDayForCalendarDate(2024, 11, 22);
  const blackFriday = getWhatDayForCalendarDate(2024, 11, 29);
  assert.equal(greenFriday.includes("グリーンフライデー"), true);
  assert.equal(greenFriday.includes("ブラックフライデー"), false);
  assert.equal(blackFriday.includes("ブラックフライデー"), true);
  assert.equal(blackFriday.includes("グリーンフライデー"), false);
});

test("2025年に固定されていた祝日と家族の日を対象年から算出する", () => {
  const cases: Array<[number, number, string]> = [
    [1, 12, "成人の日"],
    [3, 20, "春分の日"],
    [5, 10, "母の日"],
    [6, 21, "父の日"],
    [7, 20, "海の日"],
    [9, 21, "敬老の日"],
    [9, 23, "秋分の日"],
    [10, 12, "スポーツの日"],
  ];
  for (const [month, date, name] of cases) {
    assert.equal(getWhatDayForCalendarDate(2026, month, date).includes(name), true, name);
  }
  assert.equal(getWhatDayForCalendarDate(2026, 1, 13).includes("成人の日"), false);
  assert.equal(getWhatDayForCalendarDate(2026, 5, 11).includes("母の日"), false);
});
