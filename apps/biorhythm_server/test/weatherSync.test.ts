import assert from "node:assert/strict";
import test from "node:test";
import { createWeatherSync } from "../src/weatherSync.js";

const silentLogger = {
  info() {},
  warn() {},
};

test("成功した更新だけをキャッシュへ反映し、失敗時は前回値を残す", async () => {
  let weather = "晴れ";
  let attempt = 0;
  const sync = createWeatherSync(
    { setWeather: (value) => { weather = value; } },
    {
      fetchWeather: async () => {
        attempt++;
        if (attempt === 1) throw new Error("timeout");
        return "雨";
      },
      logger: silentLogger,
    },
  );

  await sync.run();
  assert.equal(weather, "晴れ");

  await sync.run();
  assert.equal(weather, "雨");
});

test("実行中の更新を重複起動しない", async () => {
  let resolveFetch!: (value: string) => void;
  let calls = 0;
  const sync = createWeatherSync(
    { setWeather() {} },
    {
      fetchWeather: () => {
        calls++;
        return new Promise((resolve) => { resolveFetch = resolve; });
      },
      logger: silentLogger,
    },
  );

  const first = sync.run();
  const second = sync.run();
  assert.equal(calls, 1);
  assert.equal(first, second);

  resolveFetch("曇り");
  await first;
});
