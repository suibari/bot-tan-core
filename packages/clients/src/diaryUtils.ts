import { MemoryService } from '@bsky-affirmative-bot/database';
import { BotDiaryActivity } from '@bsky-affirmative-bot/bot-brain';
import { LanguageName, languageData } from '@bsky-affirmative-bot/shared-configs';

/** langs の先頭要素からプロンプト用の基本言語名を決め、未指定・未知は英語にする。 */
export function getLangStr(langs: string[] | undefined): LanguageName {
  const code = langs?.[0]?.split('-')[0]?.toLowerCase() || 'en';
  const name = languageData.find((lang) => lang.code === code)?.name;
  return name ?? languageData.find((lang) => lang.code === 'en')!.name;
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
