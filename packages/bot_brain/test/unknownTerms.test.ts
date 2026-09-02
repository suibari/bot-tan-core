import assert from "node:assert/strict";
import test from "node:test";
import {
  collectsUnknownTerms,
  replyWithUnknownTermsSchema,
  sanitizeUnknownTerms,
  unwrapReplyWithTerms,
} from "../src/ai/unknownTerms.js";


/**
 * 「知らなかった語」の申告。
 *
 * 返信を書いたモデル自身が生成と同じ1回のリクエストで出すので、判定用の LLM 呼び出しも
 * 正規表現も要らない。ここで守るのは、その申告をキューへ渡す前の掃除。
 */

test("重複と表記揺れをまとめ、短すぎる語を落とす", () => {
  assert.deepEqual(
    sanitizeUnknownTerms([
      "薬屋のひとりごと",
      "  薬屋のひとりごと  ",
      "ブラッククローバー",
      "あ",
      "",
      123,
      null,
    ]),
    ["薬屋のひとりごと", "ブラッククローバー"],
  );
});

test("ASCIIの大小文字違いは同じ語として1件にする", () => {
  assert.deepEqual(sanitizeUnknownTerms(["Bluesky", "bluesky"]), ["Bluesky"]);
});

test("URLは語として扱わない", () => {
  // URL は planner を経ずに本文取得へ回る経路がある。語として検索しても意味がない。
  assert.deepEqual(
    sanitizeUnknownTerms(["https://example.com/a", "薬屋のひとりごと"]),
    ["薬屋のひとりごと"],
  );
});

test("件数と長さに上限を掛ける", () => {
  const many = Array.from({ length: 20 }, (_, index) => `作品${index}`);
  assert.equal(sanitizeUnknownTerms(many).length, 5);
  assert.equal(sanitizeUnknownTerms(["あ".repeat(200)])[0].length, 60);
});

test("配列でない申告は無視する", () => {
  for (const value of [undefined, null, "薬屋のひとりごと", {}, 0]) {
    assert.deepEqual(sanitizeUnknownTerms(value), []);
  }
});

test("自由文の機能へ渡すスキーマは reply を必須にする", () => {
  // reply が欠けると返信そのものが消える。unknownTerms は空でよい。
  const schema = replyWithUnknownTermsSchema() as any;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["reply"]);
  assert.equal(schema.properties.reply.type, "string");
  assert.equal(schema.properties.unknownTerms.type, "array");
});

test("申告を集めるのはdeferredの機能だけ", () => {
  // おみくじ等を巻き込むと、自由文だった出力が JSON に変わってしまう。
  assert.equal(collectsUnknownTerms("BSKY_AFFIRMATIVE_REPLY"), true);
  assert.equal(collectsUnknownTerms("BSKY_CONVERSATION"), true);
  assert.equal(collectsUnknownTerms("BSKY_WHIMSICAL_REPLY"), true);
  assert.equal(collectsUnknownTerms("BSKY_OMIKUJI"), false);
  assert.equal(collectsUnknownTerms("NEWS_POSITIVE_COMMENT"), false);
  assert.equal(collectsUnknownTerms(undefined), false);
});

test("構造化出力を本文と語へ解く", () => {
  const value = unwrapReplyWithTerms(
    JSON.stringify({ reply: "そうなんだ！", unknownTerms: ["薬屋のひとりごと"] }),
  );
  assert.deepEqual(value, { reply: "そうなんだ！", terms: ["薬屋のひとりごと"] });
});

test("解析に失敗しても本文を失わない", () => {
  // ここが throw すると、構造化に失敗しただけでリプライが消える。
  // 利用者に生の JSON が届かないことが最優先。
  for (const raw of ["JSONじゃない普通の返事", "", "{壊れたJSON"]) {
    const value = unwrapReplyWithTerms(raw);
    assert.equal(value.reply, raw);
    assert.deepEqual(value.terms, []);
  }
});

test("replyが無い構造化出力は素のテキスト扱いにする", () => {
  const raw = JSON.stringify({ unknownTerms: ["薬屋のひとりごと"] });
  const value = unwrapReplyWithTerms(raw);
  assert.equal(value.reply, raw, "本文を空にしない");
  assert.deepEqual(value.terms, ["薬屋のひとりごと"]);
});

test("コードブロックで包まれても解ける", () => {
  const value = unwrapReplyWithTerms(
    '```json\n{"reply":"やっほー","unknownTerms":[]}\n```',
  );
  assert.equal(value.reply, "やっほー");
});
