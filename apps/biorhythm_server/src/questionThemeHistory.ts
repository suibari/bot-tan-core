import { MemoryService } from "@bsky-affirmative-bot/clients";
import { QUESTION_THEME_HISTORY_SIZE } from "@bsky-affirmative-bot/bot-brain";

/**
 * おはようポストで出した質問テーマの履歴（新しい順）。テーマ選びで直近の問いを避けるのに使う。
 * bot_state の question_theme は最新の1件しか持たず、夜の振り返りと回答リプライ用なので別に持つ。
 */
export const QUESTION_THEME_HISTORY_KEY = "question_theme_history";

export function normalizeQuestionThemeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const themes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const theme = item.trim();
    if (!theme || seen.has(theme)) continue;
    seen.add(theme);
    themes.push(theme);
  }
  return themes.slice(0, QUESTION_THEME_HISTORY_SIZE);
}

export function addQuestionTheme(history: readonly string[], theme: string): string[] {
  return normalizeQuestionThemeHistory([theme, ...history]);
}

/** 読めなくても朝の投稿は止めない（直近を避けられないだけ）。 */
export async function loadQuestionThemeHistory(): Promise<string[]> {
  try {
    return normalizeQuestionThemeHistory(await MemoryService.getBotState(QUESTION_THEME_HISTORY_KEY));
  } catch (error) {
    console.warn("[WARN][QUESTION_THEME] 履歴を読めなかったので空として扱う", error);
    return [];
  }
}

export async function rememberQuestionTheme(history: readonly string[], theme: string): Promise<void> {
  try {
    await MemoryService.setBotState(QUESTION_THEME_HISTORY_KEY, addQuestionTheme(history, theme));
  } catch (error) {
    console.warn("[WARN][QUESTION_THEME] 履歴を書けなかった", error);
  }
}
