import rawWhatday from '../json/anniversary.json' with { type: 'json' };
import { WhatDayMap } from '../types.js';

const whatday: WhatDayMap = rawWhatday as unknown as WhatDayMap;

export function getRandomItems(array: string[], count: number) {
  if (count > array.length) {
    throw new Error("Requested count exceeds array length");
  }

  const shuffled = array.slice(); // 配列を複製してシャッフル
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); // ランダムなインデックスを選択
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; // 値を交換
  }

  return shuffled.slice(0, count); // シャッフルされた配列から先頭の要素を取得
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS_JA = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"] as const;

/** JST の壁時計に直した Date（getUTC* で読む前提）。botDay.ts / jstDate.ts と同じ固定オフセット方式。 */
const toJstWallClock = (date: Date) => new Date(date.getTime() + JST_OFFSET_MS);

function getJstCalendarParts(now: Date) {
  const jst = toJstWallClock(now);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    date: jst.getUTCDate(),
    weekday: jst.getUTCDay(),
    hours: jst.getUTCHours(),
    minutes: jst.getUTCMinutes(),
  };
}

export function getFullDateString(now: Date = new Date()) {
  const { year, month, date, weekday } = getJstCalendarParts(now);

  return `${year}年${month}月${date}日（${WEEKDAYS_JA[weekday]}）`;
}

export function getFullDateAndTimeString(now: Date = new Date()): string {
  const fulldate = getFullDateString(now);
  const { hours, minutes } = getJstCalendarParts(now);

  return `${fulldate}${hours}時${minutes}分`;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * 行動履歴の1件を、botたんが読める時刻表記に直す。
 *
 * DB には UTC で入っているが、同じプロンプトに載る「現在時刻」は JST の壁時計表記なので、
 * ISO のまま並べるとモデルが9時間ずれて読む。roomEventPrompt.ts が「ISO と混ぜると読み違える」
 * として相対分を採用したのと同じ理由で、こちらは壁時計と相対時間を両方出す。
 *
 * 例: "今日 14:05（3時間前）" / "Yesterday 23:40 (14h ago)"
 * パースできない入力はそのまま返す（履歴が1件壊れてもプロンプト全体を壊さない）。
 */
export function formatJstActivityTime(
  at: string | Date,
  now: Date,
  ja: boolean,
): string {
  const timestamp = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(timestamp)) return String(at);

  const atJst = toJstWallClock(new Date(timestamp));
  const nowJst = toJstWallClock(now);
  const clock = `${pad2(atJst.getUTCHours())}:${pad2(atJst.getUTCMinutes())}`;

  const dayDiff = Math.round(
    (Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate()) -
      Date.UTC(atJst.getUTCFullYear(), atJst.getUTCMonth(), atJst.getUTCDate())) /
      (24 * 60 * 60 * 1000),
  );
  const day =
    dayDiff === 0
      ? ja ? "今日" : "Today"
      : dayDiff === 1
        ? ja ? "昨日" : "Yesterday"
        : ja
          ? `${atJst.getUTCMonth() + 1}月${atJst.getUTCDate()}日`
          : `${atJst.getUTCMonth() + 1}/${atJst.getUTCDate()}`;

  // 未来の時刻は「たった今」に丸める（時計ずれで負の相対時間を出さない）。
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  const relative =
    elapsedMinutes < 1
      ? ja ? "たった今" : "just now"
      : elapsedMinutes < 60
        ? ja ? `${elapsedMinutes}分前` : `${elapsedMinutes}m ago`
        : elapsedMinutes < 24 * 60
          ? ja ? `${Math.floor(elapsedMinutes / 60)}時間前` : `${Math.floor(elapsedMinutes / 60)}h ago`
          : ja ? `${Math.floor(elapsedMinutes / (24 * 60))}日前` : `${Math.floor(elapsedMinutes / (24 * 60))}d ago`;

  return ja ? `${day} ${clock}（${relative}）` : `${day} ${clock} (${relative})`;
}

export function getWhatDay(now: Date = new Date()) {
  const { year, month, date } = getJstCalendarParts(now);
  return getWhatDayForCalendarDate(year, month, date);
}

/** ユーザーのローカル日付など、現在日以外の「今日は何の日」を取得する。 */
export function getWhatDayForMonthDay(month: string | number, date: string | number): string[] {
  return whatday[String(Number(month))]?.[String(Number(date))] ?? [];
}

/** 年によって日付が動く記念日を、対象年のカレンダーから加える。 */
export function getWhatDayForCalendarDate(
  year: string | number,
  month: string | number,
  date: string | number,
): string[] {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDate = Number(date);
  const names = [...getWhatDayForMonthDay(numericMonth, numericDate)];
  const weekday = getWeekdayForCalendarDate(numericYear, numericMonth, numericDate);
  const daysInMonth = new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate();

  const isNthWeekday = (targetMonth: number, targetWeekday: number, nth: number) =>
    numericMonth === targetMonth &&
    weekday === targetWeekday &&
    Math.floor((numericDate - 1) / 7) + 1 === nth;

  if (isNthWeekday(1, 1, 2)) names.push("成人の日");
  if (isNthWeekday(5, 0, 2)) names.push("母の日");
  if (isNthWeekday(6, 0, 3)) names.push("父の日");
  if (isNthWeekday(7, 1, 3)) names.push("海の日");
  if (isNthWeekday(9, 1, 3)) names.push("敬老の日");
  if (isNthWeekday(10, 1, 2)) names.push("スポーツの日");

  // 1980〜2099年の祝日判定に使える近似式。現在のbot運用期間を十分に含む。
  const yearsSince1980 = numericYear - 1980;
  const vernalEquinox = Math.floor(
    20.8431 + 0.242194 * yearsSince1980 - Math.floor(yearsSince1980 / 4),
  );
  const autumnalEquinox = Math.floor(
    23.2488 + 0.242194 * yearsSince1980 - Math.floor(yearsSince1980 / 4),
  );
  if (numericMonth === 3 && numericDate === vernalEquinox) names.push("春分の日");
  if (numericMonth === 9 && numericDate === autumnalEquinox) names.push("秋分の日");

  // 経産省の定義は「月末金曜日」。静的JSONへ特定年の日付を焼き付けない。
  if (weekday === 5 && numericDate + 7 > daysInMonth) {
    names.push("プレミアムフライデー");
  }

  // ブラックフライデーは11月第4木曜日（感謝祭）の翌日。
  if (numericMonth === 11 && weekday === 5 && numericDate >= 23 && numericDate <= 29) {
    names.push("ブラックフライデー");
  }
  if (isNthWeekday(11, 5, 4)) names.push("グリーンフライデー");

  return names;
}

export function getWeekdayForCalendarDate(
  year: string | number,
  month: string | number,
  date: string | number,
): number {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(date))).getUTCDay();
}

export function getWeekdayJaForCalendarDate(
  year: string | number,
  month: string | number,
  date: string | number,
): string {
  return WEEKDAYS_JA[getWeekdayForCalendarDate(year, month, date)];
}
