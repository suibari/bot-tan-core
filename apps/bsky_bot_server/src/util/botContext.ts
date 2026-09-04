import { getYokohamaWeather } from "@bsky-affirmative-bot/bot-brain";
import { botBiothythmManager, MemoryService } from "@bsky-affirmative-bot/clients";
import { getRecentMemoryDigests } from "@bsky-affirmative-bot/database";
import {
  configureBotContext,
  getBotContext,
} from "@bsky-affirmative-bot/bot-runtime";

configureBotContext({
  surface: "bluesky",
  getWeather: getYokohamaWeather,
  getStatus: () => botBiothythmManager.getContext(),
  getRecentActivities: async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await MemoryService.getBiorhythmHistorySince(since);
    return rows.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      activity: row.mood,
      activityEn: row.mood_en || row.mood,
    }));
  },
  // 短期記憶。ベクトル検索を通さず、直近の出来事をそのまま載せる。
  // 記憶基盤が落ちても返信そのものは止めない。
  getRecentDigests: async () => {
    try {
      const digests = await getRecentMemoryDigests(7);
      return digests.map((digest) => ({
        date: digest.digestDate,
        summary: digest.summaryJa,
      }));
    } catch (error) {
      console.warn("[WARN][BOT_CONTEXT] 短期記憶の取得に失敗", error);
      return [];
    }
  },
});

export { getBotContext };
