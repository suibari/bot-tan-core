import assert from "node:assert/strict";
import test from "node:test";
import { buildZenkatsuAwardPrompt } from "../src/ai/generateZenkatsuAward.js";

const input = {
  themeJa: "深夜2時。冷蔵庫に、何もない",
  themeEn: "2 a.m. The fridge is empty.",
  candidates: [
    {
      displayName: "すいばり",
      cardNames: ["深夜のコンビニ探検家", "積みゲーの番人"],
      reading: ["追い風: 2枚（dark属性）", "コンボ成立: 深夜徘徊"],
    },
    {
      displayName: "だれか",
      cardNames: ["白湯の癒し手"],
      reading: ["1枚で答えた"],
    },
  ],
};

test("候補は番号付きで並び、お題より後ろに置く", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  const theme = prompt.indexOf(input.themeJa);
  const first = prompt.indexOf("1. すいばり");
  assert.ok(theme > 0 && first > theme, "候補はお題より後ろ");
  assert.ok(prompt.includes("2. だれか"));
});

test("主体取り違えの禁止を、候補ブロックの直前にも再掲する", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  assert.match(prompt, /お題は\*\*架空のシチュエーション\*\*です/);
  assert.match(prompt, /その人がやったわけではありません/);
  // 候補の見出し自体にも載せる（12B では遠い指示が効きにくいため）。
  assert.match(prompt, /札の中身は、その人がした行動ではありません/);
});

test("優劣で選ばせず、選ばれなかった人を下げさせない", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  assert.match(prompt, /上手い・強いで選ばないでください/);
  assert.match(prompt, /選ばなかった人を下げる言葉は\*\*絶対に書かないこと\*\*/);
  assert.match(prompt, /ここに優劣はありません/);
});

test("理由に札の名前を出させる", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  assert.match(prompt, /最低1枚は名前で挙げて/);
});

test("読みラベルは候補ごとにそのまま渡す（数え直させない）", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  assert.ok(prompt.includes("コンボ成立: 深夜徘徊"));
  assert.ok(prompt.includes("1枚で答えた"));
});

test("口調ルールを本文側にも再掲する", () => {
  const prompt = buildZenkatsuAwardPrompt(input);
  assert.match(prompt, /敬語/);
});
