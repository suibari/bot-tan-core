import assert from "node:assert/strict";
import test from "node:test";
import {
  pickQuestionTheme,
  QUESTION_THEME_HISTORY_SIZE,
  QUESTION_THEMES,
  type QuestionTheme,
} from "../src/ai/questionThemes.js";
import { PROMPT_QUESTION } from "../src/ai/generateQuestion.js";

const NOVEMBER = new Date("2026-11-20T00:00:00+09:00");

test("テーマは重複せず、問いの形で終わる", () => {
  const texts = QUESTION_THEMES.map((theme) => theme.text);
  assert.equal(new Set(texts).size, texts.length);
  for (const text of texts) assert.match(text, /？$/, text);
});

test("意味の通らない3軸の組み合わせが出ない", () => {
  for (const { text } of QUESTION_THEMES) {
    assert.doesNotMatch(text, /インターネットの|場所・風景|食べ物・料理|動物・ペット|歌手・音楽|歴史・文化/, text);
  }
});

test("履歴の範囲では同じテーマを繰り返さない", () => {
  const recent: string[] = [];
  let random = 0.37;
  const next = () => (random = (random * 9301 + 49297) % 233280 / 233280);
  for (let i = 0; i < QUESTION_THEME_HISTORY_SIZE; i++) {
    const theme = pickQuestionTheme({ recentThemes: recent, now: NOVEMBER, random: next });
    assert.ok(!recent.includes(theme.text), `${i}回目に重複: ${theme.text}`);
    recent.unshift(theme.text);
  }
});

test("直前2回とはカテゴリを変える", () => {
  const byText = new Map(QUESTION_THEMES.map((theme) => [theme.text, theme]));
  const recent = ["猫派？ 犬派？", "朝ごはんの定番メニューは？"];
  for (let i = 0; i < 50; i++) {
    const theme = pickQuestionTheme({ recentThemes: recent, now: NOVEMBER, random: () => i / 50 });
    assert.notEqual(theme.category, byText.get(recent[0])!.category);
    assert.notEqual(theme.category, byText.get(recent[1])!.category);
  }
});

test("季節のテーマはその月にだけ出る", () => {
  const themes: QuestionTheme[] = [
    { text: "夏のテーマ？", category: "season", months: [7, 8] },
    { text: "通年のテーマ？", category: "daily" },
  ];
  for (let i = 0; i < 20; i++) {
    const theme = pickQuestionTheme({ themes, now: NOVEMBER, random: () => i / 20 });
    assert.equal(theme.text, "通年のテーマ？");
  }
});

test("候補を使い切っても古いものから戻して必ず選ぶ", () => {
  const themes: QuestionTheme[] = [
    { text: "A？", category: "daily" },
    { text: "B？", category: "daily" },
  ];
  const theme = pickQuestionTheme({ themes, recentThemes: ["A？", "B？"], now: NOVEMBER, random: () => 0 });
  assert.equal(theme.text, "B？");
});

test("プロンプトにテーマ文をそのまま渡す", () => {
  const prompt = PROMPT_QUESTION("好きなおにぎりの具は？");
  assert.match(prompt, /今回の質問は「好きなおにぎりの具は？」です/);
});
