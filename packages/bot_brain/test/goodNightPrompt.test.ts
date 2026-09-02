import assert from "node:assert/strict";
import test from "node:test";
import { buildGoodNightPrompt } from "../src/ai/generateGoodNight.js";

const base = {
  currentMood: "のんびりしていた",
  topPost: "今日はいいことがあった",
};

test("Nagi選出時はリポスト済みと説明せずURLの追記をシステムへ任せる", () => {
  const prompt = buildGoodNightPrompt({ ...base, topPostNetwork: "nagi" });

  assert.match(prompt, /全肯定されたポストはNagiの投稿/);
  assert.match(prompt, /リポスト済みとは書かない/);
  assert.match(prompt, /スレッドURLはシステムが本文末尾に追加/);
});

test("Bluesky選出時は既存どおりリポスト済みの感想を求める", () => {
  const prompt = buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" });

  assert.match(prompt, /リポスト済みなので、感想のみ/);
  assert.doesNotMatch(prompt, /全肯定されたポストはNagiの投稿/);
});

test("botContext があれば今日の記憶を、無ければ何も足さない", () => {
  const botContext = {
    datetime: "2026年8月10日22時0分",
    weather: "晴れ",
    botActivity: "ソファでのんびりしてるよ",
    botActivityEn: "Relaxing on the couch.",
    botEnergy: 30,
    recentActivities: [
      {
        at: "2026-08-10T02:05:00.000Z",
        activity: "全肯定たんは、朝ごはんを食べています。",
        activityEn: "Bot-tan is having breakfast.",
      },
    ],
  };

  const withMemory = buildGoodNightPrompt({ ...base, topPostNetwork: "bsky", botContext });
  assert.match(withMemory, /botたんの記憶/);
  assert.match(withMemory, /朝ごはん/);
  assert.match(withMemory, /1つか2つだけ拾って/);

  assert.doesNotMatch(
    buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" }),
    /botたんの記憶/,
  );
});
