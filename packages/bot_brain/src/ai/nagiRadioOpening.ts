import { getWhatDayForCalendarDate } from "@bsky-affirmative-bot/shared-configs";

export type RadioLanguage = "日本語" | "English";

/** 放送枠の日付を使う。午前8時の放送以外には記念日を載せない。 */
export function radioObservances(slotKey: string): string[] {
  if (!slotKey.endsWith("-08")) return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})-08$/.exec(slotKey);
  if (!match) return [];
  const names = getWhatDayForCalendarDate(match[1], match[2], match[3]);
  if (!names.length) return [];
  // 放送日ごとに候補から1件選ぶ。同じ枠の再試行では結果を固定する。
  const seed = [...slotKey].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return [names[seed % names.length]];
}
