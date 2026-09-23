/** 全ユーザー共通の日本時間 8・14・20 時枠。開始前は前日の20時枠。 */
export function currentRadioSlotKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(value("hour"));
  const day = hour < 8 ? new Date(now.getTime() - 24 * 60 * 60_000) : now;
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(day);
  const dateValue = (type: string) => dateParts.find((part) => part.type === type)?.value ?? "";
  const slot = hour < 8 ? "20" : hour < 14 ? "08" : hour < 20 ? "14" : "20";
  return `${dateValue("year")}-${dateValue("month")}-${dateValue("day")}-${slot}`;
}
