import { MemoryService } from '@bsky-affirmative-bot/database';
import { BotDiaryActivity } from '@bsky-affirmative-bot/bot-brain';
import { LanguageName, languageData, localeToTimezone } from '@bsky-affirmative-bot/shared-configs';

/**
 * 言語コードからタイムゾーンを取得する。
 * Bluesky・Nagi 双方の日記スケジューラが使う。
 */
export function getTimezoneFromLang(lang: string | undefined): string {
  if (!lang) return 'UTC';
  return localeToTimezone[lang] || 'UTC';
}

/** langs の先頭要素からプロンプト用の基本言語名を決め、未指定・未知は英語にする。 */
export function getLangStr(langs: string[] | undefined): LanguageName {
  const code = langs?.[0]?.split('-')[0]?.toLowerCase() || 'en';
  const name = languageData.find((lang) => lang.code === code)?.name;
  return name ?? languageData.find((lang) => lang.code === 'en')!.name;
}

/** 日記を書く時刻（ローカル22時）。 */
const DIARY_HOUR = 22;

/** 指定タイムゾーンでの「その日の0時からの経過秒」。 */
function localSecondsOfDay(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // hourCycle によっては深夜が "24" になるので丸める。
  return (at('hour') % 24) * 3600 + at('minute') * 60 + at('second');
}

/**
 * 指定タイムゾーンのローカル22時までの遅延をミリ秒で返す。
 * 22時を過ぎていれば翌日の22時。
 * ローカルの壁時計から求めているので、今から22時までの間に DST 境界を跨ぐ地域では
 * 最大1時間ずれる。スケジューラは1時間ごとに組み直すため実害はない。
 */
export function calculateDelayUntilLocal22(timezone: string, now: Date = new Date()): number {
  const secondsOfDay = localSecondsOfDay(timezone, now);
  const target = DIARY_HOUR * 3600;
  const delaySeconds = target > secondsOfDay ? target - secondsOfDay : target - secondsOfDay + 86400;
  return delaySeconds * 1000;
}

/**
 * 指定タイムゾーンで既に22時を回っているか。
 * true のときスケジューラは setTimeout（≒24時間後）ではなく即実行に切り替える。
 * これが無いと、生成失敗やプロセス再起動でその日の日記が丸ごと欠測する。
 */
export function isPastLocal22(timezone: string, now: Date = new Date()): boolean {
  return localSecondsOfDay(timezone, now) >= DIARY_HOUR * 3600;
}

/** ある瞬間における、指定タイムゾーンの UTC からのオフセット（ミリ秒）。 */
function tzOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // ローカルの壁時計をそのまま UTC として読み直し、実際の瞬間との差を取る。
  const wallClockAsUtc = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour') % 24,
    at('minute'),
    at('second'),
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * 「指定タイムゾーンの、その日の hour 時」を UTC の Date にする。
 * 過去日の日記をバックフィルするとき、材料にする投稿の収集窓を
 * 定時実行（ローカル22時）と同じ位置に合わせるために使う。
 *
 * オフセットは求めたい瞬間そのものに依存する（DST）ので、いったんUTCとして
 * 読んだ値でオフセットを引き、その結果でもう一度引き直して収束させる。
 */
export function localHourToUtc(dateStr: string, hour: number, timezone: string): Date {
  const naive = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`invalid date: ${dateStr}`);
  }
  let result = naive;
  for (let i = 0; i < 2; i++) {
    result = naive - tzOffsetMs(new Date(result), timezone);
  }
  return new Date(result);
}

/** 指定タイムゾーンでの "YYYY-MM-DD"。日記の1日1件判定に使う。 */
export function localDateStr(timezone: string, now: Date = new Date()): string {
  // en-CA は YYYY-MM-DD 形式で返る。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface DiaryData {
  dateStr: string;
  sinceDate: Date;
  activityLogs: BotDiaryActivity[];
  affirmationPosts: string[];
  receivedReplies: string[];
}

export const BOT_DIARY_MAX_ACTIVITY_LOGS = 24;
export const BOT_DIARY_MAX_INTERACTIONS_PER_KIND = 12;
export const BOT_DIARY_MAX_INTERACTION_CHARS = 600;

/**
 * 一日の先頭・中盤・末尾を落とさず、長い時系列を一定件数へ均等に縮める。
 * 末尾だけを残すと、その日のテーマではなく直前の話題だけの日記になるため、
 * 日記材料では単純な slice(-N) を使わない。
 */
export function sampleDiaryTimeline<T>(items: readonly T[], maxItems: number): T[] {
  if (maxItems <= 0 || items.length === 0) return [];
  if (items.length <= maxItems) return [...items];
  if (maxItems === 1) return [items[items.length - 1]];

  return Array.from({ length: maxItems }, (_, index) => {
    const sourceIndex = Math.round((index * (items.length - 1)) / (maxItems - 1));
    return items[sourceIndex];
  });
}

/** 重複と極端に長い1件を除き、日記プロンプトへ渡す代表テキストを作る。 */
export function selectDiaryInteractionTexts(
  values: readonly unknown[],
  maxItems = BOT_DIARY_MAX_INTERACTIONS_PER_KIND,
  maxChars = BOT_DIARY_MAX_INTERACTION_CHARS,
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(
      normalized.length > maxChars
        ? `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
        : normalized,
    );
  }
  return sampleDiaryTimeline(unique, maxItems);
}

export async function fetchDiaryData(locale: string): Promise<DiaryData> {
  const now = new Date();
  const sinceDate = new Date(now);
  if (now.getHours() < 4) {
    sinceDate.setDate(sinceDate.getDate() - 1);
  }
  sinceDate.setHours(4, 0, 0, 0);

  const year = sinceDate.getFullYear();
  const month = String(sinceDate.getMonth() + 1).padStart(2, '0');
  const day = String(sinceDate.getDate()).padStart(2, '0');
  const dateStr = `${year}/${month}/${day}`;

  let rawActivities: any[] = [];
  try {
    rawActivities = await MemoryService.getBiorhythmHistorySince(sinceDate);
  } catch (err) {
    console.error("[ERROR][DIARY] Failed to fetch Biorhythm history:", err);
  }

  const english = locale.toLowerCase().startsWith('en');
  const activityLogs: BotDiaryActivity[] = sampleDiaryTimeline(
    rawActivities.map(a => {
      let timeStr = "";
      try {
        timeStr = new Date(a.created_at).toLocaleTimeString(locale, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      } catch {
        timeStr = String(a.created_at);
      }
      return {
        time: timeStr,
        status: a.status,
        mood: english ? (a.mood_en || a.mood) : a.mood,
      };
    }),
    BOT_DIARY_MAX_ACTIVITY_LOGS,
  );

  let rawInteractions: any[] = [];
  try {
    rawInteractions = await MemoryService.getInteractionsSince(sinceDate);
  } catch (err) {
    console.error("[ERROR][DIARY] Failed to fetch Interactions:", err);
  }

  const affirmationPosts = selectDiaryInteractionTexts(
    rawInteractions
      .filter(i => i.type === "NormalReply")
      .map(i => i.details?.text),
  );

  const receivedReplies = selectDiaryInteractionTexts(
    rawInteractions
      .filter(i => i.type === "Conversation")
      .map(i => i.details?.text),
  );

  return { dateStr, sinceDate, activityLogs, affirmationPosts, receivedReplies };
}
