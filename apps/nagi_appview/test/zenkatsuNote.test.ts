import assert from "node:assert/strict";
import test from "node:test";
// モジュールが db.ts と config.ts を読むので、値の import より先にダミーを入れておく。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ||= "did:web:example.invalid";
process.env.NAGI_BOT_DID ||= "did:plc:examplebot";

const { NAGI } = await import("@bsky-affirmative-bot/nagi-lexicon");
const { validateRecord } = await import("../src/ingest/validateRecord.js");
const { visibleZenkatsuNote } = await import("../src/queries/zenkatsu.js");

const submission = (note?: unknown) => ({
  $type: NAGI.zenkatsu,
  themeDate: "2026-09-19",
  cards: [{ volume: 1, id: 1 }],
  ...(note === undefined ? {} : { note }),
  createdAt: "2026-09-19T00:00:00.000Z",
});

test("作者の意図は任意で、300字までなら通る", () => {
  assert.equal(validateRecord(NAGI.zenkatsu, submission()), true);
  assert.equal(validateRecord(NAGI.zenkatsu, submission("雨の日の物語")), true);
  assert.equal(validateRecord(NAGI.zenkatsu, submission("あ".repeat(300))), true);
});

test("301字以上・文字列以外の意図は通さない", () => {
  assert.equal(validateRecord(NAGI.zenkatsu, submission("あ".repeat(301))), false);
  assert.equal(validateRecord(NAGI.zenkatsu, submission(42)), false);
  assert.equal(validateRecord(NAGI.zenkatsu, submission(null)), false);
});

test("文字数は書記素で数える（絵文字1つは1字）", () => {
  assert.equal(validateRecord(NAGI.zenkatsu, submission("😀".repeat(300))), true);
  assert.equal(validateRecord(NAGI.zenkatsu, submission("😀".repeat(301))), false);
  // 書記素数が収まっていても、3000バイトを超えるものは通さない（lexicon の maxLength）。
  assert.equal(validateRecord(NAGI.zenkatsu, submission("👨‍👩‍👧".repeat(200))), false);
});

test("判定待ちの意図は返さない", () => {
  assert.deepEqual(visibleZenkatsuNote({ note: "物語", noteModerationVersion: null }), {});
  assert.deepEqual(
    visibleZenkatsuNote({ note: "物語", noteModerationVersion: "nagi-moderation-v4" }),
    { note: "物語" },
  );
  assert.deepEqual(
    visibleZenkatsuNote({ note: null, noteModerationVersion: "nagi-moderation-v4" }),
    {},
  );
});
