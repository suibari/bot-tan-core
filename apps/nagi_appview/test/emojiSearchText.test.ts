import assert from "node:assert/strict";
import test from "node:test";
import {
  customEmojiEmbedText,
  formatEmojiSearchText,
  kanaToRomaji,
  normalizeEmojiText,
} from "../src/services/emojiSearchText.js";
import { buildUnicodeEmojiRows } from "../src/services/unicodeEmojiIndex.js";

const romaji = (value: string) => kanaToRomaji(normalizeEmojiText(value));

test("かなを本番の絵文字名の書き方のローマ字にする", () => {
  assert.equal(romaji("ざんねん"), "zannen");
  assert.equal(romaji("かくにんしました"), "kakuninshimashita");
  assert.equal(romaji("ちょいまち"), "choimachi");
  assert.equal(romaji("まっちゃ"), "matcha");
  // 長音は直前の母音を重ねる（:okkee: :suruu_shimasu:）。
  assert.equal(romaji("おっけー"), "okkee");
  assert.equal(romaji("スルー"), "suruu");
  assert.equal(romaji("ふぁいなるあんさー"), "fainaruansaa");
  assert.equal(romaji("じゃあね"), "jaane");
});

test("かなを含まない検索語はローマ字にしない", () => {
  assert.equal(romaji("ok"), undefined);
  assert.equal(romaji("残念"), undefined);
});

test("読み取り文は1行目が画像の文字、2行目が説明、残りが連想語", () => {
  assert.equal(
    formatEmojiSearchText({ text: " 解散 ", description: "青い\n文字", keywords: ["終わり", " ", "お開き"] }),
    "解散\n青い 文字\n終わり\nお開き",
  );
  assert.equal(
    customEmojiEmbedText({ name: ":kaisan_desu:", alt: null, searchText: "解散" }),
    "kaisan desu\n解散",
  );
});

test("Unicode 絵文字の行は ja/en を結合し、検索キーを正規化する", () => {
  const [row] = buildUnicodeEmojiRows(
    [{ emoji: "🐱", annotation: "ねこの顔", tags: ["ねこ", "動物"], order: 5 }],
    [{ emoji: "🐱", annotation: "cat face", tags: ["cat", "pet"], shortcodes: ["cat"] }],
    "v",
  );
  assert.equal(row.labelJa, "ねこの顔");
  assert.equal(row.labelEn, "cat face");
  assert.equal(row.labels, "ネコノ顔\ncat face");
  assert.equal(row.keywords, "ネコノ顔\ncat face\ncat\nネコ\n動物\npet");
  assert.equal(row.embedText, "ねこの顔 / cat face\nねこ、動物\ncat, pet");
  assert.equal(row.sortOrder, 5);
});
