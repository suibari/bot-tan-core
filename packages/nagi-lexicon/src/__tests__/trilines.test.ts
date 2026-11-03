import assert from "node:assert/strict";
import test from "node:test";
import { NAGI, TRILINES, nagiPostFromTrilinesDiary } from "../index.js";

const blob = (cid: string) => ({
  $type: "blob",
  ref: { $link: cid },
  mimeType: "image/jpeg",
  size: 1000,
});

const diary = (overrides: Record<string, unknown> = {}) => ({
  $type: TRILINES.diary,
  lines: [
    { text: "朝ごはんがおいしかった" },
    { text: "猫をなでた", image: blob("bafycat"), alt: "猫" },
    { text: "早く寝た" },
  ],
  langs: ["ja"],
  createdAt: "2026-11-03T12:00:00.000Z",
  ...overrides,
});

test("3行日記を投稿へ射影する", () => {
  const post = nagiPostFromTrilinesDiary(diary());
  assert.equal(post?.$type, NAGI.post);
  assert.equal(post?.text, "朝ごはんがおいしかった\n猫をなでた\n早く寝た");
  assert.deepEqual(post?.langs, ["ja"]);
  // botたんは日記にも返信する。
  assert.equal(post?.botSilent, undefined);
  assert.deepEqual(post?.trilines, {
    lines: [
      { text: "朝ごはんがおいしかった" },
      { text: "猫をなでた", imageIndex: 0 },
      { text: "早く寝た" },
    ],
  });
  assert.equal(post?.embed.$type, `${NAGI.post}#images`);
  assert.deepEqual(post?.embed.images, [{ image: blob("bafycat"), alt: "猫" }]);
});

test("画像がなければ embed を付けない", () => {
  const post = nagiPostFromTrilinesDiary(diary({ lines: [{ text: "一行" }] }));
  assert.equal(post?.embed, undefined);
});

test("壊れた日記は射影しない", () => {
  assert.equal(nagiPostFromTrilinesDiary(diary({ $type: "blue.trilinesat.diary" })), undefined);
  assert.equal(nagiPostFromTrilinesDiary(diary({ lines: [] })), undefined);
  assert.equal(
    nagiPostFromTrilinesDiary(diary({ lines: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }] })),
    undefined,
  );
  assert.equal(nagiPostFromTrilinesDiary(diary({ lines: [{ text: "  " }] })), undefined);
  assert.equal(nagiPostFromTrilinesDiary(diary({ createdAt: "nope" })), undefined);
  assert.equal(
    nagiPostFromTrilinesDiary(diary({ lines: [{ text: "a", image: "x" }] })),
    undefined,
  );
});
