import assert from "node:assert/strict";
import test from "node:test";
import {
  committedDiaryDayHistory,
  diaryDateOf,
  diaryDayWindow,
  dueDiaryDay,
  DIARY_DAY_BASELINE_DATE,
  DIARY_DAY_START_HOURS,
  isEmptyDiaryDay,
  isUsableDetectedTimezone,
  nextDiaryDayEffectiveDate,
  type DiaryDayHistory,
} from "../src/diaryDay.js";

const only = (timezone: string, startHour = 22): DiaryDayHistory => [
  { effectiveFrom: DIARY_DAY_BASELINE_DATE, timezone, startHour },
];

const iso = (date: Date) => date.toISOString();

test("22時区切りは前日22時の直後〜当日22時", () => {
  const history = only("Asia/Tokyo");
  const window = diaryDayWindow("2026-11-06", history);
  assert.equal(iso(window.start), "2026-11-05T13:00:00.000Z");
  assert.equal(iso(window.end), "2026-11-06T13:00:00.000Z");
  // 22:00 ちょうどは当日、その直後は翌日。
  assert.equal(diaryDateOf(new Date("2026-11-06T22:00:00+09:00"), history), "2026-11-06");
  assert.equal(diaryDateOf(new Date("2026-11-06T22:00:00.001+09:00"), history), "2026-11-07");
  assert.equal(diaryDateOf(new Date("2026-11-06T00:30:00+09:00"), history), "2026-11-06");
});

test("朝区切りは当日の区切り〜翌日の区切りが当日", () => {
  const history = only("Asia/Tokyo", 2);
  const window = diaryDayWindow("2026-11-06", history);
  assert.equal(iso(window.start), "2026-11-05T17:00:00.000Z"); // 11/6 02:00 JST
  assert.equal(iso(window.end), "2026-11-06T17:00:00.000Z"); // 11/7 02:00 JST
  assert.equal(diaryDateOf(new Date("2026-11-07T01:59:00+09:00"), history), "2026-11-06");
  assert.equal(diaryDateOf(new Date("2026-11-07T02:00:01+09:00"), history), "2026-11-07");
  assert.equal(diaryDateOf(new Date("2026-11-06T01:00:00+09:00"), history), "2026-11-05");
});

test("どの区切りでも、窓の真ん中がその日付の暦日に入る", () => {
  for (const timezone of ["Pacific/Kiritimati", "Etc/GMT+12", "Asia/Kolkata", "America/St_Johns"]) {
    for (const startHour of DIARY_DAY_START_HOURS) {
      const history = only(timezone, startHour);
      const window = diaryDayWindow("2026-03-10", history);
      const middle = new Date((window.start.getTime() + window.end.getTime()) / 2);
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(middle);
      assert.equal(local, "2026-03-10", `${timezone} ${startHour}`);
      assert.equal(diaryDateOf(window.end, history), "2026-03-10");
      assert.equal(diaryDateOf(new Date(window.end.getTime() + 1), history), "2026-03-11");
      assert.equal(diaryDateOf(new Date(window.start.getTime() + 1), history), "2026-03-10");
    }
  }
});

test("夏時間の切り替え日は23時間・25時間になり、隙間はできない", () => {
  const london = only("Europe/London");
  // 2026-03-29 01:00 UTC に夏時間開始。
  const spring = diaryDayWindow("2026-03-29", london);
  assert.equal(iso(spring.start), "2026-03-28T22:00:00.000Z");
  assert.equal(iso(spring.end), "2026-03-29T21:00:00.000Z");
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 3_600_000);
  // 2026-10-25 01:00 UTC に夏時間終了。
  const autumn = diaryDayWindow("2026-10-25", london);
  assert.equal(autumn.end.getTime() - autumn.start.getTime(), 25 * 3_600_000);

  // 区切りが存在しない時刻（米国の 2:00 開始）でも決定的に決まり、窓が連続する。
  const ny = only("America/New_York", 2);
  const before = diaryDayWindow("2026-03-07", ny);
  const gap = diaryDayWindow("2026-03-08", ny);
  assert.equal(iso(before.end), iso(gap.start));
  assert.ok(gap.end > gap.start);
  assert.equal(diaryDateOf(gap.end, ny), "2026-03-08");
});

test("履歴: 変更より前の日は当時の設定、切り替わりの日は前の日の終わりから", () => {
  const history: DiaryDayHistory = [
    { effectiveFrom: DIARY_DAY_BASELINE_DATE, timezone: "Asia/Tokyo", startHour: 22 },
    { effectiveFrom: "2026-11-07", timezone: "Asia/Tokyo", startHour: 2 },
  ];
  const before = diaryDayWindow("2026-11-06", history);
  assert.equal(iso(before.end), "2026-11-06T13:00:00.000Z");
  const transition = diaryDayWindow("2026-11-07", history);
  assert.equal(iso(transition.start), "2026-11-06T13:00:00.000Z"); // 11/6 22:00 JST
  assert.equal(iso(transition.end), "2026-11-07T17:00:00.000Z"); // 11/8 02:00 JST（28時間）
  assert.equal(diaryDateOf(new Date("2026-11-06T23:00:00+09:00"), history), "2026-11-07");
  assert.equal(diaryDateOf(new Date("2026-11-08T01:00:00+09:00"), history), "2026-11-07");
  assert.equal(diaryDateOf(new Date("2026-11-08T03:00:00+09:00"), history), "2026-11-08");
});

test("有効になる日: 区切りが後ろへ動くときは今開いている日から", () => {
  const history = only("Asia/Tokyo");
  // 11/6 20:00 JST に 2時区切りへ。今開いている 11/6 の日が 11/7 02:00 まで伸びる。
  const date = nextDiaryDayEffectiveDate(
    history,
    { timezone: "Asia/Tokyo", startHour: 2 },
    new Date("2026-11-06T20:00:00+09:00"),
    "2026-11-05",
  );
  assert.equal(date, "2026-11-06");
});

test("有効になる日: その日の日記が書かれていれば翌日から", () => {
  const history = only("Asia/Tokyo");
  // 23:00 にはもう 11/6 の日記がある。開いているのは 11/7。
  const date = nextDiaryDayEffectiveDate(
    history,
    { timezone: "Asia/Tokyo", startHour: 2 },
    new Date("2026-11-06T23:00:00+09:00"),
    "2026-11-06",
  );
  assert.equal(date, "2026-11-07");
  // 日記が遅れていて書かれていなくても、窓の終わった日は変えない（開いている日から）。
  assert.equal(
    nextDiaryDayEffectiveDate(
      history,
      { timezone: "Asia/Tokyo", startHour: 2 },
      new Date("2026-11-06T23:00:00+09:00"),
    ),
    "2026-11-07",
  );
});

test("有効になる日: 新しい区切りがもう過ぎていれば翌日から", () => {
  const history = only("Asia/Tokyo");
  // 20:00 に 18時区切りへ。今日の 18:00 は過ぎているので、今日は 22:00 のまま。
  const date = nextDiaryDayEffectiveDate(
    history,
    { timezone: "Asia/Tokyo", startHour: 18 },
    new Date("2026-11-06T20:00:00+09:00"),
  );
  assert.equal(date, "2026-11-07");
  const next = [...history, { effectiveFrom: date, timezone: "Asia/Tokyo", startHour: 18 }];
  const window = diaryDayWindow("2026-11-07", next);
  assert.equal(window.end.getTime() - window.start.getTime(), 20 * 3_600_000);
});

test("大きく東へ動くと日付が1つ飛び、前後は隙間なくつながる", () => {
  const history = only("America/Los_Angeles", 6);
  const next = { timezone: "Asia/Tokyo", startHour: 18 };
  const now = new Date("2026-11-06T12:00:00Z"); // 11/6 04:00 PST、開いているのは 11/5
  const date = nextDiaryDayEffectiveDate(history, next, now);
  assert.equal(date, "2026-11-07");
  const updated = [...history, { effectiveFrom: date, ...next }];
  const last = diaryDayWindow("2026-11-06", updated); // 旧設定の最後の日
  const skipped = diaryDayWindow("2026-11-07", updated);
  const first = diaryDayWindow("2026-11-08", updated);
  assert.equal(isEmptyDiaryDay(skipped), true);
  assert.equal(isEmptyDiaryDay(first), false);
  assert.equal(iso(first.start), iso(last.end));
  for (const at of ["2026-11-07T08:00:00Z", "2026-11-07T10:00:00Z", "2026-11-07T14:00:00Z"])
    assert.equal(diaryDateOf(new Date(at), updated), "2026-11-06", at);
  assert.equal(diaryDateOf(new Date("2026-11-07T14:00:00.001Z"), updated), "2026-11-08");
});

test("大きく西へ動くと切り替わりの日が長くなる", () => {
  const history = only("Asia/Tokyo");
  const next = { timezone: "America/Los_Angeles", startHour: 22 };
  const now = new Date("2026-11-06T12:00:00+09:00");
  const date = nextDiaryDayEffectiveDate(history, next, now);
  assert.equal(date, "2026-11-06");
  const updated = [...history, { effectiveFrom: date, ...next }];
  const window = diaryDayWindow(date, updated);
  assert.equal(window.end.getTime() - window.start.getTime(), (24 + 17) * 3_600_000);
  assert.equal(iso(diaryDayWindow("2026-11-07", updated).start), iso(window.end));
});

test("予約中の行は committed から外れる", () => {
  const history: DiaryDayHistory = [
    { effectiveFrom: DIARY_DAY_BASELINE_DATE, timezone: "Asia/Tokyo", startHour: 22 },
    { effectiveFrom: "2026-11-06", timezone: "Asia/Tokyo", startHour: 2 },
    { effectiveFrom: "2026-11-08", timezone: "Asia/Tokyo", startHour: 4 },
  ];
  const committed = committedDiaryDayHistory(history, new Date("2026-11-06T20:00:00+09:00"));
  assert.deepEqual(
    committed.map((entry) => entry.effectiveFrom),
    [DIARY_DAY_BASELINE_DATE, "2026-11-06"],
  );
});

test("自動検出では UTC や Etc/* を使わない", () => {
  assert.equal(isUsableDetectedTimezone("Europe/London"), true);
  assert.equal(isUsableDetectedTimezone("UTC"), false);
  assert.equal(isUsableDetectedTimezone("Etc/GMT-9"), false);
  assert.equal(isUsableDetectedTimezone("Not/AZone"), false);
  assert.equal(isUsableDetectedTimezone(42), false);
});

test("書くべき日: 窓が閉じた直後から、次の日の窓が閉じるまで", () => {
  const history = only("Asia/Tokyo", 2);
  // 11/7 02:00 JST に 11/6 の窓が閉じる。
  assert.equal(dueDiaryDay(history, new Date("2026-11-07T01:59:00+09:00"))?.date, "2026-11-05");
  assert.equal(dueDiaryDay(history, new Date("2026-11-07T02:00:01+09:00"))?.date, "2026-11-06");
  assert.equal(dueDiaryDay(history, new Date("2026-11-08T01:59:00+09:00"))?.date, "2026-11-06");

  // 空の日は飛ばして、その前の日を書く。
  const east: DiaryDayHistory = [
    ...only("America/Los_Angeles", 6),
    { effectiveFrom: "2026-11-07", timezone: "Asia/Tokyo", startHour: 18 },
  ];
  // 11/7 15:00Z は 11/8 の日の途中。前の 11/7 は空なので 11/6 を書く。
  const due = dueDiaryDay(east, new Date("2026-11-07T15:00:00Z"));
  assert.equal(due?.date, "2026-11-06");
});
