/**
 * 日記の「1日」の決め方。日記の生成（nagi_bot_server / bsky_bot_server）と AppView の
 * 日付の割り当て（日記・感情グラフ・関わった人）は、必ずここの関数だけを使う。
 *
 * 1日は「区切りの時刻の直後〜次の区切りの時刻」。日付は窓の真ん中（終わりの12時間前）が
 * 入っている暦日にする。22時区切りなら前日22時〜当日22時が「当日」、2時区切りなら
 * 当日2時〜翌2時が「当日」。区切りを 18時〜翌6時に限っているのはこの決め方のため
 * （昼を区切りにすると真ん中が0時付近に来て、日付が直感とずれる）。
 *
 * 区切り（タイムゾーンと時刻）は「いつから有効か」を付けた履歴で持つ。各日の窓は
 * 「前の日の終わり〜その日の設定で計算した終わり」なので、設定が変わった日だけ長さが
 * 変わり、隙間も重なりもできない。過去の日は当時の設定のまま。
 *
 * タイムゾーンが大きく東へ動くと（ロサンゼルス→東京など）、新しい設定での終わりが
 * 前の日の終わりより前に来ることがある。そういう日は空（日付が1つ飛ぶ。実際に日付変更線を
 * 越えたのと同じ）にする。空の日には日記を書かず、どの瞬間もその日には入らない。
 */

export const DIARY_DAY_DEFAULT_START_HOUR = 22;

/** 選べる区切りの時刻。夕方から翌朝の順。 */
export const DIARY_DAY_START_HOURS = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6] as const;

/** 履歴が無い人の、いちばん古い行の effectiveFrom。この日より前は無い扱い。 */
export const DIARY_DAY_BASELINE_DATE = "1970-01-01";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DiaryDaySetting = { timezone: string; startHour: number };

/** 履歴の1行。effectiveFrom の日から（その日の窓の終わりから）この設定で区切る。 */
export type DiaryDayScheduleEntry = DiaryDaySetting & { effectiveFrom: string };

/** effectiveFrom の昇順。空でないこと（先頭は DIARY_DAY_BASELINE_DATE）。 */
export type DiaryDayHistory = readonly DiaryDayScheduleEntry[];

export type DiaryDayWindow = DiaryDaySetting & {
  date: string;
  /** この瞬間は含まない（前の日に入る）。 */
  start: Date;
  /** この瞬間までを含む。 */
  end: Date;
};

export function isDiaryDayStartHour(value: unknown): value is number {
  return (DIARY_DAY_START_HOURS as readonly number[]).includes(value as number);
}

/** IANA のタイムゾーン名として使えるか。Intl が受け付けない名前は不可。 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * ブラウザから自動で届いたタイムゾーンを受け付けるか。UTC や Etc/* は、Firefox の
 * 耐フィンガープリンティングなどが本当の場所を隠すときに返すので、自動検出では使わない
 * （手動で選ぶのは構わない）。
 */
export function isUsableDetectedTimezone(value: unknown): value is string {
  if (!isValidTimezone(value)) return false;
  return !/^(UTC|GMT|UCT|Zulu|Universal|Etc\/.*)$/i.test(value);
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function isDiaryDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** その瞬間の、timezone の UTC からのずれ（ミリ秒、分単位に丸める）。 */
function offsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(at("year"), at("month") - 1, at("day"), at("hour") % 24, at("minute"));
  const floored = Math.floor(instant / 60_000) * 60_000;
  return Math.round((wall - floored) / 60_000) * 60_000;
}

/**
 * timezone の壁時計で date の hour 時ちょうどの瞬間。オフセットは求めたい瞬間に依存する
 * （夏時間）ので2回測って合わせる。存在しない時刻（夏時間の始まり）は1時間後ろ、
 * 2回ある時刻（終わり）はどちらか一方に決まる。どちらでも結果は決定的。
 */
export function zonedHourToInstant(date: string, hour: number, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour);
  const first = naive - offsetMs(naive, timezone);
  return new Date(naive - offsetMs(first, timezone));
}

/** timezone での暦日 "YYYY-MM-DD"。 */
export function zonedDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** 1つの設定で計算した、date の日の終わり。夕方区切りは当日、朝区切りは翌日の区切り。 */
export function diaryDayEnd(date: string, setting: DiaryDaySetting): Date {
  const endDate = setting.startHour >= 12 ? date : shiftDate(date, 1);
  return zonedHourToInstant(endDate, setting.startHour, setting.timezone);
}

/** date の日に有効な設定。 */
export function diaryDaySettingFor(date: string, history: DiaryDayHistory): DiaryDaySetting {
  if (!history.length) throw new Error("diary day history is empty");
  let current: DiaryDayScheduleEntry = history[0];
  for (const entry of history) {
    if (entry.effectiveFrom > date) break;
    current = entry;
  }
  return { timezone: current.timezone, startHour: current.startHour };
}

const endFor = (date: string, history: DiaryDayHistory) =>
  diaryDayEnd(date, diaryDaySettingFor(date, history));

/**
 * date の日の窓。start は前の日の終わり（前の日の設定で計算する）。空の日を挟むと
 * 前の日の終わりがさらに前の日より早いことがあるので、直前2日の遅いほうを取る
 * （終わりは UTC で当日 04:00〜翌 18:00 に収まるので、3日前の終わりは必ず2日前より早い）。
 * end <= start なら空の日。
 */
export function diaryDayWindow(date: string, history: DiaryDayHistory): DiaryDayWindow {
  const setting = diaryDaySettingFor(date, history);
  const start = Math.max(
    endFor(shiftDate(date, -1), history).getTime(),
    endFor(shiftDate(date, -2), history).getTime(),
  );
  return { date, ...setting, start: new Date(start), end: diaryDayEnd(date, setting) };
}

/** 空の日（タイムゾーンが東へ動いて飛んだ日付）か。 */
export const isEmptyDiaryDay = (window: { start: Date; end: Date }) =>
  window.end.getTime() <= window.start.getTime();

/**
 * その瞬間が入る日記の日付。終わりがその瞬間以上になる最初の日が答え（空の日の終わりは
 * 前の日の終わり以下なので、空の日が選ばれることはない）。終わりは UTC で当日 04:00〜
 * 翌 18:00 の間に収まる（UTC+14 の18時区切り〜UTC-12 の6時区切り）ので、UTC の日付の
 * 前後数日を見れば足りる。
 */
export function diaryDateOf(instant: Date, history: DiaryDayHistory): string {
  const utcDate = instant.toISOString().slice(0, 10);
  const time = instant.getTime();
  for (let shift = -2; shift <= 3; shift++) {
    const date = shiftDate(utcDate, shift);
    if (time <= endFor(date, history).getTime()) return date;
  }
  return shiftDate(utcDate, 3);
}

/** 窓に入るか（start は含まず、end は含む）。 */
export function isInDiaryDayWindow(instant: Date, window: { start: Date; end: Date }): boolean {
  const time = instant.getTime();
  return time > window.start.getTime() && time <= window.end.getTime();
}

/**
 * 新しい設定をいつから有効にするか。
 * - 新しい区切りの時刻がまだ来ていない、いちばん近い日から（今開いている日を含む）。
 * - その日の日記がすでに書かれていれば翌日から（書いた日記の窓は変えない）。
 * 区切りの時刻だけの変更なら、切り替わりの日は12〜36時間になる。タイムゾーンの変更では
 * もっと短い日や空の日（日付が飛ぶ）もありうるが、それは実際に移動した1日の長さ。
 *
 * history には「予約中」（今開いている日より後に有効になる行）を含めないこと。
 * 予約は新しい変更で置き換える。
 */
export function nextDiaryDayEffectiveDate(
  history: DiaryDayHistory,
  next: DiaryDaySetting,
  now: Date,
  lastDiaryDate?: string,
): string {
  const open = diaryDateOf(now, history);
  for (let shift = 0; shift < 7; shift++) {
    const date = shiftDate(open, shift);
    if (lastDiaryDate && date <= lastDiaryDate) continue;
    if (diaryDayEnd(date, next).getTime() <= now.getTime()) continue;
    return date;
  }
  // ここには来ない（7日先なら必ず条件を満たす）が、念のため1週間後にする。
  return shiftDate(open, 7);
}

/**
 * 日記を書くべき日。今開いている日の前の日（空の日なら、さらに前）で、窓が閉じていること。
 * 窓が閉じてから次の日の窓が閉じるまでの約24時間、書けるまで拾い直す。
 */
export function dueDiaryDay(history: DiaryDayHistory, now: Date): DiaryDayWindow | undefined {
  const open = diaryDateOf(now, history);
  for (let shift = 1; shift <= 3; shift++) {
    const window = diaryDayWindow(shiftDate(open, -shift), history);
    if (!isEmptyDiaryDay(window)) return window.end <= now ? window : undefined;
  }
  return undefined;
}

/** 今開いている日（予約中の行は除いて）より後に有効になる行を落とす。 */
export function committedDiaryDayHistory(history: DiaryDayHistory, now: Date): DiaryDayScheduleEntry[] {
  // 予約中の行は「まだ有効になっていない」ので、開いている日の判定から外す。
  // 予約は必ず開いている日より後（nextDiaryDayEffectiveDate が保証）なので、
  // 予約を外した履歴で開いている日を求めても同じ日になる。
  const sorted = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const committed: DiaryDayScheduleEntry[] = [];
  for (const entry of sorted) {
    if (!committed.length) {
      committed.push(entry);
      continue;
    }
    const open = diaryDateOf(now, committed);
    if (entry.effectiveFrom <= open) committed.push(entry);
  }
  return committed;
}

export const sameDiaryDaySetting = (a: DiaryDaySetting, b: DiaryDaySetting) =>
  a.timezone === b.timezone && a.startHour === b.startHour;
