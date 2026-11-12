import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLICIT_SEXUAL_TERMS,
  findExplicitTerms,
  normalizeForTerms,
} from "../src/services/moderation/explicitTerms.js";

test("matches katakana, hiragana and half-width spellings", () => {
  for (const text of ["パイズリ", "ぱいずり", "ﾊﾟｲｽﾞﾘ", "今日はパイズリの話"])
    assert.deepEqual(findExplicitTerms([text]), ["パイズリ"], text);
});

test("matches inside surrounding Japanese text", () => {
  assert.deepEqual(findExplicitTerms(["昨日ふぇらしてもらった"]), ["フェラ"]);
  assert.deepEqual(findExplicitTerms(["チンコ"]), ["ちんこ"]);
});

test("looks at every text part (body, alt, link card)", () => {
  assert.deepEqual(findExplicitTerms(["普通の本文", "画像の説明: 素股"]), ["素股"]);
});

test("returns each term once", () => {
  assert.deepEqual(findExplicitTerms(["パイズリ", "ぱいずり パイズリ"]), ["パイズリ"]);
});

/** 2026-11-10 に本番データへ当てたときに出た誤検知と、同じ型の語。 */
test("does not match longer words that merely contain a term", () => {
  for (const text of [
    "1円ぱちんこで1000円取れた",
    "パチンコやと思ってやめた",
    "のすふぇらとぅさん",
    "ノスフェラトゥ",
    "フェラーリに乗りたい",
    "ルシフェラーゼで光る",
    "フェラガモの靴",
  ])
    assert.deepEqual(findExplicitTerms([text]), [], text);
});

/**
 * 区切り照合で外れる例。2026-11-12 の「かわいいカフェラテ」が部分一致で当たったのが発端。
 * ICU の辞書が Node の更新で変わったら、ここが先に落ちる。
 */
test("does not match a term in the middle of a word", () => {
  for (const text of [
    "かわいいカフェラテ",
    "アイスカフェラテください",
    "モカフェラテ",
    "ガチンコ勝負",
    "背中出しコーデ",
    "街中出しゃばる",
  ])
    assert.deepEqual(findExplicitTerms([text]), [], text);
});

test("matches a term that spans several word segments", () => {
  const cases: Array<[string, string]> = [
    ["フェラした", "フェラ"],
    ["フェラ顔", "フェラ"],
    ["ドフェラ", "フェラ"],
    ["ﾌｪﾗ", "フェラ"],
    ["カフェラテとフェラ", "フェラ"],
    ["中出しされた", "中出し"],
    ["ちんこ立った", "ちんこ"],
    ["おまんこ", "まんこ"],
    ["手コキされた", "手コキ"],
    ["ハメ撮り", "ハメ撮り"],
    ["顔射", "顔射"],
  ];
  for (const [text, term] of cases)
    assert.deepEqual(findExplicitTerms([text]), [term], text);
});

test("an excluded occurrence does not hide a real one in the same text", () => {
  assert.deepEqual(findExplicitTerms(["パチンコ帰りにちんこ"]), ["ちんこ"]);
});

test("everyday words are not on the list", () => {
  for (const text of ["えっち", "エロい", "おっぱい", "性癖に刺さる", "セックスレス", "潮吹き", "ぶっかけうどん"])
    assert.deepEqual(findExplicitTerms([text]), [], text);
});

test("ignores empty input", () => {
  assert.deepEqual(findExplicitTerms([]), []);
  assert.deepEqual(findExplicitTerms([""]), []);
});

test("every exception contains its term, so it can actually exclude something", () => {
  for (const { term, except = [] } of EXPLICIT_SEXUAL_TERMS)
    for (const word of except)
      assert.ok(
        normalizeForTerms(word).includes(normalizeForTerms(term)),
        `${word} does not contain ${term}`,
      );
});
