import assert from "node:assert/strict";
import test from "node:test";
import { QUESTION_THEME_HISTORY_SIZE } from "@bsky-affirmative-bot/bot-brain";
import { addQuestionTheme, normalizeQuestionThemeHistory } from "../src/questionThemeHistory.js";

test("壊れた値は空として読む", () => {
  assert.deepEqual(normalizeQuestionThemeHistory(null), []);
  assert.deepEqual(normalizeQuestionThemeHistory("猫派？"), []);
  assert.deepEqual(normalizeQuestionThemeHistory([1, "", " 猫派？ ", "猫派？"]), ["猫派？"]);
});

test("新しいテーマを先頭に足し、上限で古いものを捨てる", () => {
  const old = Array.from({ length: QUESTION_THEME_HISTORY_SIZE }, (_, i) => `テーマ${i}？`);
  const next = addQuestionTheme(old, "新しい？");
  assert.equal(next.length, QUESTION_THEME_HISTORY_SIZE);
  assert.equal(next[0], "新しい？");
  assert.ok(!next.includes(`テーマ${QUESTION_THEME_HISTORY_SIZE - 1}？`));
});

test("同じテーマは先頭へ移す", () => {
  assert.deepEqual(addQuestionTheme(["A？", "B？"], "B？"), ["B？", "A？"]);
});
