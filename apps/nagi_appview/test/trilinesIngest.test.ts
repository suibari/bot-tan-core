import assert from "node:assert/strict";
import test from "node:test";
import { NAGI, TRILINES } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";
import { isQuotablePostUri, trilinesView } from "../src/queries/trilines.js";
import { decideNagiReplyJob } from "@bsky-affirmative-bot/bot-runtime";
import { nagiPostFromTrilinesDiary } from "@bsky-affirmative-bot/nagi-lexicon";

const blob = {
  $type: "blob",
  ref: { $link: "bafycat" },
  mimeType: "image/jpeg",
  size: 1000,
};
const diary = (overrides: Record<string, unknown> = {}) => ({
  $type: TRILINES.diary,
  lines: [{ text: "朝ごはん" }, { text: "猫", image: blob, alt: "猫" }, { text: "早寝" }],
  langs: ["ja"],
  createdAt: "2026-11-03T12:00:00.000Z",
  ...overrides,
});

test("3行日記を検証する", () => {
  assert.equal(validateRecord(TRILINES.diary, diary()), true);
  assert.equal(validateRecord(TRILINES.diary, diary({ lines: [{ text: "あ".repeat(51) }] })), false);
  assert.equal(
    validateRecord(TRILINES.diary, diary({ lines: [{ text: "a", image: { ...blob, mimeType: "image/svg+xml" } }] })),
    false,
  );
  assert.equal(validateRecord(TRILINES.diary, diary({ $type: "blue.trilinesat.diary" })), false);
});

test("日記の URI のときだけ行ビューを返す", () => {
  const record = { trilines: { lines: [{ text: "a" }, { text: "b", imageIndex: 0 }] } };
  assert.deepEqual(trilinesView(`at://did:plc:a/${TRILINES.diary}/3abc`, record), {
    trilines: { lines: [{ text: "a" }, { text: "b", imageIndex: 0 }] },
  });
  assert.deepEqual(trilinesView(`at://did:plc:a/${NAGI.post}/3abc`, record), {});
  assert.deepEqual(trilinesView(`at://did:plc:a/${TRILINES.diary}/3abc`, {}), {});
});

test("botたんは日記にも返信ジョブを積む", () => {
  const post = nagiPostFromTrilinesDiary(diary());
  assert.deepEqual(decideNagiReplyJob(post, "did:plc:alice", "did:plc:bot"), {
    enqueue: true,
    toBot: false,
  });
});

test("日記とブログ記事も引用カードとして読み込む", () => {
  assert.equal(isQuotablePostUri(`at://did:plc:a/${TRILINES.diary}/3abc`), true);
  assert.equal(isQuotablePostUri(`at://did:plc:a/${NAGI.post}/3abc`), true);
  assert.equal(isQuotablePostUri("at://did:plc:a/site.standard.document/3abc"), true);
  assert.equal(isQuotablePostUri(`at://did:plc:a/${NAGI.news}/3abc`), false);
  assert.equal(isQuotablePostUri(null), false);
});
