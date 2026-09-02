import assert from "node:assert/strict";
import test from "node:test";
import { POST_TEXT_LIMIT } from "@bsky-affirmative-bot/shared-configs";
import { exceedsTextLimit, resolveTextLimit } from "../src/ai/util.js";

test("未指定なら投稿用の POST_TEXT_LIMIT が既定になる", () => {
  assert.equal(resolveTextLimit(undefined), POST_TEXT_LIMIT);
  assert.equal(resolveTextLimit(300), 300);
});

test("null は上限なしの明示（既定値へフォールバックしない）", () => {
  assert.equal(resolveTextLimit(null), null);
});

test("上限なしなら、どれだけ長くてもリトライしない", () => {
  // 日次予定表は25件のイベントを持つJSONで、投稿にはならないので2100字を超えて当然。
  // ここで引っかけても縮まらず、リトライ回数ぶん焼くだけになる。
  assert.equal(exceedsTextLimit("あ".repeat(POST_TEXT_LIMIT * 3), null), false);
});

test("上限があるときは超過だけを弾く", () => {
  assert.equal(exceedsTextLimit("あ".repeat(POST_TEXT_LIMIT), POST_TEXT_LIMIT), false);
  assert.equal(exceedsTextLimit("あ".repeat(POST_TEXT_LIMIT + 1), POST_TEXT_LIMIT), true);
  assert.equal(exceedsTextLimit("", POST_TEXT_LIMIT), false);
});
