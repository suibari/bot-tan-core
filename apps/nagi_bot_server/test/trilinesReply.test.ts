import assert from "node:assert/strict";
import test from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:bot";
const { trilinesDiaryLines } = await import("../src/createNagiReply.js");

const record = { trilines: { lines: [{ text: "a" }, { text: " " }, { text: "c" }] } };

test("日記の URI なら各行を返す", () => {
  assert.deepEqual(
    trilinesDiaryLines("at://did:plc:a/com.suibari.trilinesat.diary/3abc", record),
    ["a", "c"],
  );
});

test("通常の投稿に trilines が書かれていても日記扱いしない", () => {
  assert.equal(trilinesDiaryLines("at://did:plc:a/com.suibari.nagi.post/3abc", record), undefined);
  assert.equal(
    trilinesDiaryLines("at://did:plc:a/com.suibari.trilinesat.diary/3abc", { text: "x" }),
    undefined,
  );
});
