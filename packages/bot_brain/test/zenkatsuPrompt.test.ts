import assert from "node:assert/strict";
import test from "node:test";
import { CARD_DEFS } from "@bsky-affirmative-bot/shared-configs";
import {
  buildZenkatsuCommentPrompt,
  normalizeZenkatsuCommentCardNames,
} from "../src/ai/generateZenkatsuComment.js";

const input = {
  displayName: "すいばり",
  themeJa: "傘を持っていない日に限って、空が光った",
  themeEn: "The one day you left the umbrella at home, the sky flashes.",
  cards: [CARD_DEFS[10], CARD_DEFS[6]],
  reading: ["追い風: 1枚（傘を持ってきた予言者・wind属性）", "編成の傾向: 守り寄り（ATK合計1800 / DEF合計1600）"],
};

test("出した札はお題と読みラベルより後ろに置く", () => {
  // AGENTS.md の並び順ルール。ユーザーの入力より後ろに材料を積むと主体と時制を取り違える。
  const prompt = buildZenkatsuCommentPrompt(input);
  const theme = prompt.indexOf(input.themeJa);
  const reading = prompt.indexOf(input.reading[0]);
  const cards = prompt.indexOf(`1枚目: ${input.cards[0].nameJa}`);
  assert.ok(theme > 0 && reading > theme, "読みラベルはお題より後ろ");
  assert.ok(cards > reading, "出した札はいちばん後ろ");
});

test("主体取り違えの禁止を、冒頭とカードブロックの直前の二箇所に置く", () => {
  // Gemma4-12b では冒頭の禁止事項だけでは遠すぎる。対象の隣にも再掲する。
  const prompt = buildZenkatsuCommentPrompt(input);
  const occurrences = prompt.split("この人がした行動ではありません").length - 1;
  // 各カードのラベル（2枚ぶん）＋ カードブロックの見出し
  assert.ok(occurrences >= 3, `再掲が足りない: ${occurrences}`);
  assert.match(prompt, /お題は\*\*架空のシチュエーション\*\*です/);
  assert.match(prompt, /この人がやったわけではありません/);
  assert.match(prompt, /肯定するのは「その状況に、この札を選んだ」という選択/);
});

test("フィールド名そのものにルールを載せる", () => {
  // ラベルは値の真隣にあるので、小さいモデルにいちばん確実に効く。
  const prompt = buildZenkatsuCommentPrompt(input);
  assert.match(prompt, /札の説明文（この人がした行動ではありません）: /);
  assert.ok(!prompt.includes("フレーバーテキスト:"));
});

test("読みラベルは計算済みとして渡し、数え直させない", () => {
  const prompt = buildZenkatsuCommentPrompt(input);
  assert.match(prompt, /計算済みです。そのまま使ってよく、数え直す必要はありません/);
  for (const line of input.reading) assert.ok(prompt.includes(line));
});

test("不正解を作らないルールが入っている", () => {
  const prompt = buildZenkatsuCommentPrompt(input);
  assert.match(prompt, /外している・ずれている・惜しい、とは絶対に言わないこと/);
  assert.match(prompt, /追い風に合っていないことを、欠点として指摘しないで/);
});

test("1枚で答えたときは短く返させる", () => {
  const one = buildZenkatsuCommentPrompt({ ...input, cards: [CARD_DEFS[10]] });
  assert.match(one, /最大80文字/);
  const three = buildZenkatsuCommentPrompt(input);
  assert.match(three, /最大140文字/);
});

test("口調ルールを本文側にも再掲する（説明文が文語調なので引きずられる）", () => {
  const prompt = buildZenkatsuCommentPrompt(input);
  assert.match(prompt, /敬語/);
  assert.match(prompt, /その文体には引きずられないこと/);
});

test("表示名はそのまま埋め、プレースホルダを残さない", () => {
  const prompt = buildZenkatsuCommentPrompt(input);
  assert.ok(prompt.includes("すいばり さんが出した札"));
  assert.ok(!/\{\{|\}\}/.test(prompt));
});

test("カードの英語名も渡す（英語出力で別言語が混ざるのを防ぐ）", () => {
  // 日本語名しか渡さないと commentEn でモデルが自力翻訳し、12B では別言語が漏れる
  // （実測で「積みゲーの番人」が韓国語になった）。
  const prompt = buildZenkatsuCommentPrompt(input);
  for (const card of input.cards) {
    assert.ok(prompt.includes(card.nameJa), card.nameJa);
    assert.ok(prompt.includes(card.nameEn), card.nameEn);
  }
  assert.match(prompt, /下に書いてある英語名をそのまま使ってください。自分で訳さないこと/);
  assert.match(prompt, /commentEn は全体を英語だけで書いてください/);
  assert.match(prompt, /日本語名をそのまま使ってください。英語名を混ぜないこと/);
});

test("保存前に日本語総評の英語カード名と英語総評の日本語カード名を揃える", () => {
  const cards = CARD_DEFS.filter((card) =>
    ["One Who Never Let Go", "Morpho, the Butterfly of Happiness", "Missionary of Total Affirmation"]
      .includes(card.nameEn));
  assert.equal(cards.length, 3);
  const result = normalizeZenkatsuCommentCardNames({
    commentJa: "One Who Never Let Go と Morpho, the Butterfly of Happiness を選んだのがいいね。Missionary of Total Affirmationまで添えるなんて！",
    commentEn: "好きを貫く者 and 全肯定の伝道師 make a great pair.",
  }, cards);
  assert.equal(result.commentJa, "好きを貫く者 と 幸せのモルフォ蝶 を選んだのがいいね。全肯定の伝道師まで添えるなんて！");
  assert.equal(result.commentEn, "One Who Never Let Go and Missionary of Total Affirmation make a great pair.");
});

test("提出していない札と英単語の一部は置き換えない", () => {
  const card = CARD_DEFS.find((item) => item.nameEn === "One Who Never Let Go");
  assert.ok(card);
  const result = normalizeZenkatsuCommentCardNames({
    commentJa: "One Who Never Let Goはいいね。XOne Who Never Let GoXとMissionary of Total Affirmationはそのまま。",
    commentEn: "好きを貫く者 is great.",
  }, [card]);
  assert.equal(result.commentJa, "好きを貫く者はいいね。XOne Who Never Let GoXとMissionary of Total Affirmationはそのまま。");
});
