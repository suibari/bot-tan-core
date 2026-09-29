/**
 * 日本の国民の祝日（振替休日・国民の休日を含む）。
 *
 * botたんは学校に通っているので、平日か休日かで1日の過ごし方が変わる。土日だけで
 * 判定していた頃は祝日も「登校日」になり、敬老の日に授業を受けていた。
 *
 * 2007年以降の祝日法（振替休日は「日曜の祝日以降で最も近い祝日でない日」）に従う。
 * 2020・2021年の五輪特例のような一時的な移動は扱わない（運用期間外）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const FIXED_HOLIDAYS: Record<string, string> = {
  "1-1": "元日",
  "2-11": "建国記念の日",
  "2-23": "天皇誕生日",
  "4-29": "昭和の日",
  "5-3": "憲法記念日",
  "5-4": "みどりの日",
  "5-5": "こどもの日",
  "8-11": "山の日",
  "11-3": "文化の日",
  "11-23": "勤労感謝の日",
};

/** [月, 第n, 名前]。いずれも月曜日。 */
const HAPPY_MONDAYS: [number, number, string][] = [
  [1, 2, "成人の日"],
  [7, 3, "海の日"],
  [9, 3, "敬老の日"],
  [10, 2, "スポーツの日"],
];

/** 1980〜2099年で使える春分・秋分の日の近似式。 */
export function equinoxDays(year: number): { vernal: number; autumnal: number } {
  const yearsSince1980 = year - 1980;
  const leapCorrection = Math.floor(yearsSince1980 / 4);
  return {
    vernal: Math.floor(20.8431 + 0.242194 * yearsSince1980 - leapCorrection),
    autumnal: Math.floor(23.2488 + 0.242194 * yearsSince1980 - leapCorrection),
  };
}

const utcParts = (timestamp: number) => {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    date: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
};

/** 振替休日・国民の休日を除いた、祝日法の本則の祝日名。 */
function baseHolidayName(timestamp: number): string | undefined {
  const { year, month, date, weekday } = utcParts(timestamp);
  const fixed = FIXED_HOLIDAYS[`${month}-${date}`];
  if (fixed) return fixed;
  const nth = Math.floor((date - 1) / 7) + 1;
  const happyMonday = HAPPY_MONDAYS.find(
    ([targetMonth, targetNth]) => weekday === 1 && month === targetMonth && nth === targetNth,
  );
  if (happyMonday) return happyMonday[2];
  const { vernal, autumnal } = equinoxDays(year);
  if (month === 3 && date === vernal) return "春分の日";
  if (month === 9 && date === autumnal) return "秋分の日";
  return undefined;
}

/** その日の祝日名。祝日でなければ undefined。 */
export function getJapaneseHolidayName(
  year: number,
  month: number,
  date: number,
): string | undefined {
  const timestamp = Date.UTC(year, month - 1, date);
  const base = baseHolidayName(timestamp);
  if (base) return base;

  // 振替休日: 直前に続く祝日の並びの中に日曜があれば、その並びの翌日が休みになる。
  for (let cursor = timestamp - DAY_MS; baseHolidayName(cursor); cursor -= DAY_MS) {
    if (utcParts(cursor).weekday === 0) return "振替休日";
  }

  // 国民の休日: 前後を祝日に挟まれた日（例: 2026-09-22 は敬老の日と秋分の日の間）。
  if (baseHolidayName(timestamp - DAY_MS) && baseHolidayName(timestamp + DAY_MS)) {
    return "国民の休日";
  }
  return undefined;
}

/** 土日または祝日。 */
export function isJapaneseDayOff(year: number, month: number, date: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return weekday === 0 || weekday === 6 || getJapaneseHolidayName(year, month, date) !== undefined;
}
