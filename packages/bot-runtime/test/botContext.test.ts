import assert from "node:assert/strict";
import test from "node:test";
import { configureBotContext, getBotContext } from "../src/botContext.js";

test("biorhythmの状態に含まれるキャッシュ済み天気を使う", async () => {
  let statusCalls = 0;
  configureBotContext({
    getStatus: async () => {
      statusCalls++;
      return { mood: "読書中", mood_en: "Reading", energy: 72, weather: "曇り" };
    },
  });

  const context = await getBotContext();

  assert.equal(statusCalls, 1);
  assert.equal(context.weather, "曇り");
  assert.equal(context.botActivity, "読書中");
});
