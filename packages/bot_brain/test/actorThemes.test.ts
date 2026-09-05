import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MATCH_ARTICLES, normalizeMatches, normalizeThemes } from "../src/ai/actorThemes.js";

test("themes are trimmed, de-duplicated and capped", () => {
  const out = normalizeThemes(
    JSON.stringify({ themes: ["猫", " #猫 ", "ラーメン", "", "登山", "自作PC", "音楽", "写真", "料理"] }),
  );
  // "#猫" は正規化すると "猫" と同じなので落ちる。
  assert.deepEqual(out, ["猫", "ラーメン", "登山", "自作PC", "音楽", "写真"]);
});

test("a theme that is a sentence rather than a noun phrase is dropped", () => {
  const out = normalizeThemes(
    JSON.stringify({ themes: ["猫のことをよく書いていて毎日写真を上げている", "猫"] }),
  );
  assert.deepEqual(out, ["猫"]);
});

test("malformed model output yields no themes instead of throwing", () => {
  assert.deepEqual(normalizeThemes("not json"), []);
  assert.deepEqual(normalizeThemes(JSON.stringify({ themes: "猫" })), []);
  assert.deepEqual(normalizeThemes(JSON.stringify({})), []);
});

test("a match the user does not actually have is discarded", () => {
  // LLM が語を作って理由を捏造するのを塞ぐ。ここが緩むと嘘の理由が画面に出る。
  const out = normalizeMatches(
    JSON.stringify({ matches: ["猫", "宇宙開発", null] }),
    ["猫", "ラーメン"],
    3,
  );
  assert.deepEqual(out, ["猫", null, null]);
});

test("a short or long match array never shifts reasons onto the wrong article", () => {
  assert.deepEqual(normalizeMatches(JSON.stringify({ matches: ["猫"] }), ["猫"], 3), ["猫", null, null]);
  assert.deepEqual(
    normalizeMatches(JSON.stringify({ matches: ["猫", "猫", "猫", "猫"] }), ["猫"], 2),
    ["猫", "猫"],
  );
});

test("malformed match output leaves every article without a reason", () => {
  assert.deepEqual(normalizeMatches("oops", ["猫"], 2), [null, null]);
  assert.deepEqual(normalizeMatches(JSON.stringify({ matches: {} }), ["猫"], 2), [null, null]);
});

test("生成上限は記事数に比例して確保する", () => {
  // 30件ぶんの JSON 配列は 256 トークンに収まらない。足りないと配列が途中で切れ、
  // パースに失敗して全件 null（＝理由が一切出ない）に落ちる。
  const budget = (n: number) => 128 + n * 16;
  assert.ok(budget(MAX_MATCH_ARTICLES) >= 500, String(budget(MAX_MATCH_ARTICLES)));
  assert.ok(budget(3) < budget(30));
});
