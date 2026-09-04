export type BotSurface = "nagi" | "bluesky";

export type RuntimeBotContext = {
  datetime: string;
  weather: string;
  botActivity: string;
  botActivityEn: string;
  botEnergy: number;
  surface?: BotSurface;
  recentActivities?: RuntimeBotActivity[];
  recentDigests?: RuntimeBotDigest[];
};

/**
 * 短期記憶。直近数日の出来事を1日1件にまとめたもの（新しい順）。
 *
 * recentActivities が「botたん自身が何をしていたか」なのに対し、こちらは
 * 「まわりで何があったか」。bot_memory_daily_digests が出どころで、
 * ベクトル検索を通していない。
 */
export type RuntimeBotDigest = {
  /** JST の "YYYY-MM-DD"。 */
  date: string;
  summary: string;
};

export type RuntimeBotActivity = {
  at: string;
  activity: string;
  activityEn: string;
};

type BotContextSources = {
  getWeather: () => Promise<string>;
  getStatus: () => Promise<{ mood: string; mood_en: string; energy: number }>;
  getRecentActivities?: () => Promise<RuntimeBotActivity[]>;
  getRecentDigests?: () => Promise<RuntimeBotDigest[]>;
  /** このプロセスがどのSNSに向いているか。プロセス単位で固定なのでキャッシュに載せない。 */
  surface?: BotSurface;
};

let sources: BotContextSources | undefined;
let cache:
  { value: Omit<RuntimeBotContext, "datetime">; time: number } | undefined;
const TTL_MS = 5 * 60 * 1000;

export function configureBotContext(value: BotContextSources) {
  sources = value;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * botたんの「現在時刻」。JST 固定で出す。
 *
 * ローカルタイムゾーン依存だと、サーバーが UTC のときにこの値だけ9時間ずれ、同じプロンプトへ
 * 一緒に載る行動履歴の時刻（formatJstActivityTime が JST で出す）と食い違う。
 * shared-configs には依存していないパッケージなので、botDay.ts / jstDate.ts と同じ
 * 固定オフセット方式をここにも置く。
 */
function dateTime() {
  const jst = new Date(Date.now() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日${jst.getUTCHours()}時${jst.getUTCMinutes()}分`;
}

export async function getBotContext(): Promise<RuntimeBotContext> {
  if (!sources) throw new Error("Bot context sources are not configured");
  if (!cache || Date.now() - cache.time > TTL_MS) {
    const [weather, status, recentActivities, recentDigests] = await Promise.all([
      sources.getWeather(),
      sources.getStatus(),
      sources.getRecentActivities?.() ?? Promise.resolve([]),
      sources.getRecentDigests?.() ?? Promise.resolve([]),
    ]);
    cache = {
      value: {
        weather,
        botActivity: status.mood,
        botActivityEn: status.mood_en,
        botEnergy: status.energy,
        ...(recentActivities.length ? { recentActivities } : {}),
        ...(recentDigests.length ? { recentDigests } : {}),
      },
      time: Date.now(),
    };
  }
  return {
    datetime: dateTime(),
    ...cache.value,
    ...(sources.surface ? { surface: sources.surface } : {}),
  };
}
