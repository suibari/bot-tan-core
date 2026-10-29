/**
 * 年表の週次ロールアップで使う日付の計算。DB に触らない純関数だけ置く。
 *
 * 日付はすべて "YYYY-MM-DD"（diaries.diary_date と同じ text）。週は月曜始まりで、
 * Postgres の date_trunc('week', …)（ISO 週）と揃えてある。
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 週次に切り替えた日。この日以降の日記は週ごと、それより前は月ごと（chronicle_jobs）。
 * 2026-11-01 は日曜なので、最初の週は 10/26 の週のうち 11/1 だけを材料にする
 * （10月分は月次で拾われているので、二重にも取りこぼしにもならない）。
 */
export const CHRONICLE_WEEKLY_SINCE = "2026-11-01";

/** 月次ロールアップを回す最後の月の翌月。これより前の月だけ chronicle_jobs に積む。 */
export const CHRONICLE_WEEKLY_SINCE_MONTH = CHRONICLE_WEEKLY_SINCE.slice(0, 7);

export function isChronicleDate(value: string): boolean {
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** その日を含む週の月曜。 */
export function chronicleWeekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/** 週の最終日（日曜）。 */
export function chronicleWeekEnd(weekStart: string): string {
  return addDays(weekStart, 6);
}

/** その週が閉じたか。today は cardDrawDate（JST 4:00 始まり）で見た今日。 */
export function isChronicleWeekClosed(weekStart: string, today: string): boolean {
  return chronicleWeekEnd(weekStart) < today;
}

/**
 * その週で材料にしてよい日付の範囲 [from, until)。
 * 切替日をまたぐ最初の週は、切替日より前を月次に任せて切り落とす。
 */
export function chronicleWeekRange(weekStart: string): { from: string; until: string } {
  const from = weekStart < CHRONICLE_WEEKLY_SINCE ? CHRONICLE_WEEKLY_SINCE : weekStart;
  return { from, until: addDays(weekStart, 7) };
}
