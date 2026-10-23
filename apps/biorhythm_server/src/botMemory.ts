import type { BotContext } from "@bsky-affirmative-bot/shared-configs";
import { getFullDateAndTimeString } from "@bsky-affirmative-bot/shared-configs";
import { recentOwnPostsFor, tomorrowHookFor, type SelfPostMemory } from "./selfPostMemory.js";

/** getBiorhythmHistorySince() が返す行のうち、記憶として使う部分だけ。 */
export type BiorhythmHistoryRow = {
  mood: string;
  mood_en?: string | null;
  created_at: Date | string;
};

export type BuildBiorhythmBotContextInput = {
  mood: string;
  moodEn: string;
  energy: number;
  weather: string;
  history: BiorhythmHistoryRow[];
  /** 自分の直近の投稿と前夜のひとこと（selfPostMemory.ts）。 */
  selfPosts?: SelfPostMemory;
  now?: Date;
};

/**
 * 定期ポスト（おはよう / 気まぐれ / おやすみ）へ渡す botたんの記憶。
 *
 * bot-runtime の getBotContext() を使わないのは意図的。あちらは TTL 5分のキャッシュを持つが、
 * 定期ポストは manager.step() が setOutput() で mood を更新した直後に発火するので、
 * キャッシュを引くと「いまやってること」だけ1世代古い値になり、記憶との矛盾を自分で作ってしまう。
 * ここは manager が持っている今の値からその場で組み立てる。
 *
 * surface は設定しない。定期ポストは Bluesky と Nagi の両方へ同一本文で配信されるので、
 * どちらか一方を名指しすると片方で嘘になる。
 */
export function buildBiorhythmBotContext(
  input: BuildBiorhythmBotContextInput,
): BotContext {
  const recentActivities = input.history
    .map((row) => ({
      at: new Date(row.created_at).toISOString(),
      activity: row.mood,
      activityEn: row.mood_en || row.mood,
    }))
    // addBiorhythmHistory() はポスト判定より前に走るので、履歴の末尾は「いまやってること」と
    // 同じ行になっている。そのまま渡すと同じ出来事を2回読ませることになるので落とす。
    .filter((item, index, items) =>
      index === items.length - 1 ? item.activity !== input.mood : true,
    );

  const now = input.now ?? new Date();
  const recentOwnPosts = input.selfPosts ? recentOwnPostsFor(input.selfPosts, now) : [];
  const tomorrowHook = input.selfPosts ? tomorrowHookFor(input.selfPosts, now) : undefined;

  return {
    datetime: getFullDateAndTimeString(),
    weather: input.weather,
    botActivity: input.mood,
    botActivityEn: input.moodEn || input.mood,
    botEnergy: input.energy,
    ...(recentActivities.length ? { recentActivities } : {}),
    ...(recentOwnPosts.length ? { recentOwnPosts } : {}),
    ...(tomorrowHook ? { tomorrowHook } : {}),
  };
}
