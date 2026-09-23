import { getWhatDayForCalendarDate } from "@bsky-affirmative-bot/shared-configs";

export type RadioLanguage = "日本語" | "English";

const ENGLISH_NAMES: Record<string, string> = {
  "成人の日": "Coming of Age Day",
  "春分の日": "Vernal Equinox Day",
  "母の日": "Mother's Day",
  "父の日": "Father's Day",
  "海の日": "Marine Day",
  "敬老の日": "Respect for the Aged Day",
  "秋分の日": "Autumnal Equinox Day",
  "スポーツの日": "Sports Day",
  "国際平和デー": "the International Day of Peace",
};

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

export function radioGreeting(slotKey: string, language: RadioLanguage): string {
  const morning = slotKey.endsWith("-08");
  const afternoon = slotKey.endsWith("-14");
  if (language === "English") return morning ? "Good morning!" : afternoon ? "Good afternoon!" : "Good evening!";
  if (!morning) return afternoon ? "こんにちは！" : "こんばんは！";
  const [first] = radioObservances(slotKey);
  return `おはよう！${first ? `今日は${first}だね。` : ""}`;
}

/** 英語名が分からない記念日は固有名詞として原語を残し、朝の1件を省略しない。 */
export function englishRadioObservances(slotKey: string): string[] {
  return radioObservances(slotKey).map((name) => ENGLISH_NAMES[name] ?? `${name} in Japan`);
}
