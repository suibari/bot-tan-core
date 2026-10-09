import assert from "node:assert/strict";
import test from "node:test";
import { createEmbeddingRetryBackoff } from "../src/embeddingRetryBackoff.js";

test("失敗した行は指数的に待たせ、成功で忘れる", () => {
  let now = 0;
  const backoff = createEmbeddingRetryBackoff({ baseMs: 100, maxMs: 300, now: () => now });

  backoff.fail("a");
  assert.equal(backoff.blocked("a"), true);
  assert.equal(backoff.blocked("b"), false);
  now = 100;
  assert.equal(backoff.blocked("a"), false, "1回目は baseMs");

  backoff.fail("a");
  now = 299;
  assert.equal(backoff.blocked("a"), true, "2回目は 2倍");
  now = 300;
  assert.equal(backoff.blocked("a"), false);

  backoff.fail("a");
  backoff.fail("a");
  now = 600;
  assert.equal(backoff.blocked("a"), false, "maxMs で頭打ち");

  backoff.succeed("a");
  assert.equal(backoff.size(), 0);
});

test("待ちが明けてさらに maxMs 経った記録は忘れる（削除された行で溜まらない）", () => {
  let now = 0;
  const backoff = createEmbeddingRetryBackoff({ baseMs: 100, maxMs: 300, now: () => now });
  backoff.fail("gone");
  now = 399;
  assert.equal(backoff.size(), 1);
  now = 400;
  assert.equal(backoff.size(), 0);
});
