import { getYokohamaWeather } from "@bsky-affirmative-bot/bot-brain";

const WEATHER_REFRESH_INTERVAL_MS = 10 * 60_000;

type WeatherManager = {
  setWeather(weather: string): void;
};

type WeatherSyncDependencies = {
  fetchWeather: () => Promise<string>;
  logger: Pick<Console, "info" | "warn">;
};

const defaultDependencies: WeatherSyncDependencies = {
  fetchWeather: getYokohamaWeather,
  logger: console,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 外部APIの待ち時間を返信生成から分離するための単一実行ワーカー。
 * 取得に失敗した回は現在値を変更せず、次回の定期実行へ持ち越す。
 */
export function createWeatherSync(
  manager: WeatherManager,
  dependencies: WeatherSyncDependencies = defaultDependencies,
) {
  let running: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      try {
        const weather = await dependencies.fetchWeather();
        if (!weather) return;
        manager.setWeather(weather);
        dependencies.logger.info(`[INFO][WEATHER] Refreshed: ${weather}`);
      } catch (error) {
        dependencies.logger.warn(
          `[WARN][WEATHER] Refresh failed; keeping the previous value: ${errorMessage(error)}`,
        );
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return { run };
}

export async function scheduleWeatherSync(manager: WeatherManager): Promise<void> {
  const sync = createWeatherSync(manager);
  await sync.run();
  setInterval(() => void sync.run(), WEATHER_REFRESH_INTERVAL_MS);
}
