import assert from "node:assert/strict";
import test from "node:test";
import { isResearchableWord, researchLabelsFrom } from "../src/researchLabels.js";

/**
 * 印象ラベルのうち調査キューへ積むもの。
 *
 * 例はどれも本番の調査キューに実際に積まれていたラベル（2026-11-07 時点）。
 * 言葉ラベルの検索は全体の83%を占め、成功は14%だった。当たらない検索は自前 SearXNG の
 * 上流にボットとして目を付けられる原因になるので、文と一般語は積まない。
 */

test("固有名詞らしい言葉は調べる", () => {
  for (const label of [
    "トリシューラ",
    "ショックルーラー",
    "ゴッド・ブレイズ・キャノン",
    "トドロクツキ",
    "ゾロアーク",
    "リフレクトスライム",
    "パーク24",
    "Zora's Domain",
    "Linux Mint",
    "Atproto",
  ]) {
    assert.equal(isResearchableWord(label), true, label);
  }
});

test("文の形をした言葉は調べない", () => {
  for (const label of [
    "その答えはデュエルの中で見つけるしかない",
    "ラーを使ってるデッキでどこまでパンプアップできるか",
    "新規カード0にした",
    "雨だったがお出かけなどがんばった",
    "おすそわけをしたい",
    "漫画を描きたく無い",
    "やってるのに減らねぇなぁ",
    "おはようございます＼(^o^)／",
    "俺を呼んだか！？",
    "today is my birthday",
    "what game should i even play",
  ]) {
    assert.equal(isResearchableWord(label), false, label);
  }
});

test("英語の一般語・相づちは調べない", () => {
  // 調べても「good」「Yes!!」のカードができるだけで、しかも投稿に語が出れば
  // 返信の材料に入るので、英語の投稿に片っ端から混ざる。
  for (const label of ["good", "birthday", "dog breeders", "Yes!!", "True", "Fuck no", "Thank you"]) {
    assert.equal(isResearchableWord(label), false, label);
  }
});

test("短すぎる・長すぎる言葉は調べない", () => {
  assert.equal(isResearchableWord("あ"), false);
  assert.equal(isResearchableWord("ア".repeat(21)), false);
});

test("作品名は文の形をしていても調べる", () => {
  // 題名は長かったり文の形をしていたりするのが普通なので、作品ラベルは絞らない。
  assert.deepEqual(
    researchLabelsFrom([
      { kind: "work", label: "転生したら剣でした" },
      { kind: "work", label: "追放されたチート付与魔術師は気ままなセカンドライフを謳歌する" },
      { kind: "word", label: "その答えはデュエルの中で見つけるしかない" },
      { kind: "word", label: "トリシューラ" },
      { kind: "word", label: "good" },
    ]),
    [
      "転生したら剣でした",
      "追放されたチート付与魔術師は気ままなセカンドライフを謳歌する",
      "トリシューラ",
    ],
  );
});
