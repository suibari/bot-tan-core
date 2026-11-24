import assert from "node:assert/strict";
import test from "node:test";
import { buildNagiLinkedPost } from "../src/bsky/nagiLinkedPost.js";

const nagiPost = { uri: "at://did:plc:bot/com.suibari.nagi.post/3kpost", cid: "nagi-cid" };
const url = "https://nagi.suibari.com/thread/did%3Aplc%3Abot/3kpost";
const nagiLink = { label: "🌐 English", seeMoreLabel: "もっと見る" };
const bytes = (value: string) => new TextEncoder().encode(value).length;
const graphemes = (value: string) =>
  [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(value)].length;
const linked = (text: string, label: string) => {
  const start = bytes(text.slice(0, text.lastIndexOf(label)));
  return { byteStart: start, byteEnd: start + bytes(label) };
};

test("収まる本文は全文の後ろに別言語への導線と末尾を置く", () => {
  const result = buildNagiLinkedPost({
    text: "おはよう！",
    footer: "#全肯定質問コーナー",
    nagiLink,
    nagiPost,
  })!;
  assert.equal(result.text, "おはよう！\n\n🌐 English\n\n#全肯定質問コーナー");
  assert.deepEqual(result.linkFacets, [
    {
      index: linked(result.text, "🌐 English"),
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    },
  ]);
  assert.equal(result.longPost, undefined);
});

test("収まらない本文は冒頭で切り、もっと見ると導線を Nagi へリンクし、目印を付ける", () => {
  const result = buildNagiLinkedPost({
    text: "あ".repeat(400),
    footer: "#全肯定質問コーナー",
    nagiLink,
    nagiPost,
  })!;
  assert.ok(graphemes(result.text) <= 300);
  assert.match(result.text, /^あ+…もっと見る\n\n🌐 English\n\n#全肯定質問コーナー$/);
  assert.deepEqual(
    result.linkFacets.map((facet) => facet.index),
    [linked(result.text, "もっと見る"), linked(result.text, "🌐 English")],
  );
  assert.deepEqual(result.longPost, nagiPost);
});

test("冒頭は改行を優先して切り、URL の途中では切らない", () => {
  const song = "https://www.youtube.com/watch?v=" + "x".repeat(40);
  const text = `${"い".repeat(200)}\n${"う".repeat(40)} ${song} ${"え".repeat(100)}`;
  const result = buildNagiLinkedPost({ text, nagiLink, nagiPost })!;
  assert.ok(result.text.startsWith(`${"い".repeat(200)}…もっと見る`));
});

test("英語の回は See more と日本語への導線になる", () => {
  const result = buildNagiLinkedPost({
    text: "Hello ".repeat(80),
    nagiLink: { label: "🌐 日本語", seeMoreLabel: "See more" },
    nagiPost,
  })!;
  assert.match(result.text, /…See more\n\n🌐 日本語$/);
  assert.ok(graphemes(result.text) <= 300);
});

test("Nagi の投稿でない URI ならリンクを作らない", () => {
  assert.equal(
    buildNagiLinkedPost({
      text: "おはよう",
      nagiLink,
      nagiPost: { uri: "at://did:plc:bot/app.bsky.feed.post/1", cid: "c" },
    }),
    undefined,
  );
});
