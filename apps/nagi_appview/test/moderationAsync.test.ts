import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 「モデレーション判定でユーザー・botたん・取り込みのレスポンスを遅らせない」
 * が最優先の要件。取り込み経路が OpenAI を待つ形に戻っていないことを、実 DB を
 * 立てずに検証できる範囲で固定しておく。
 */

const read = (path: string) =>
  readFile(new URL(path, import.meta.url), "utf8");

const applyMutation = await read("../src/ingest/applyMutation.ts");
const kossoriPosts = await read("../src/queries/kossoriPosts.ts");
const worker = await read("../src/ingest/moderationWorker.ts");
const openai = await read("../src/services/moderation/openai.ts");

test("applyMutation never evaluates moderation inline", () => {
  assert.doesNotMatch(
    applyMutation,
    /evaluateModerationInput|OpenAIModerator|api\.openai\.com/,
  );
});

test("applyMutation only signals the worker and does not await it", () => {
  assert.match(applyMutation, /if \(moderated\) wakeModerationWorker\(\);/);
  assert.doesNotMatch(applyMutation, /await wakeModerationWorker/);
});

test("the kossori creation path does not reach moderation at all", () => {
  assert.doesNotMatch(
    kossoriPosts,
    /moderation|evaluateModerationInput|openai/i,
  );
});

test("only the worker talks to OpenAI", () => {
  assert.match(worker, /evaluateModerationInput/);
  assert.match(openai, /api\.openai\.com/);
});

test("the worker leaves the pending marker alone when the failure is retryable", () => {
  // moderation_version を NULL のまま残す＝次周回で拾い直す、というコメントと
  // 実装（catch して continue するだけ）が対応していること。
  assert.match(worker, /moderation_version は NULL のまま残る/);
  assert.doesNotMatch(worker, /process\.exit/);
});

/**
 * allow を無音にすると「安全と判定された」のか「ワーカーが動いていない」のか
 * 運用者が区別できない。判定1件につき必ず1行出すことを固定する。
 */
test("every completed judgement is logged, including allow", () => {
  assert.match(worker, /function logDecision\(/);
  assert.match(worker, /if \(decision === "allow"\) console\.log\(line\);/);
  // judge() の最後で必ず呼ぶ（reject 経路だけで終わらせない）。
  assert.match(
    worker,
    /await applyDecision\(item, decision, labels\);\n\s*logDecision\(/,
  );
});

test("the pending backlog is reported once at startup", () => {
  assert.match(worker, /\[moderationWorker\] pending:/);
});

test("applyMutation marks non-judged records as skipped rather than pending", () => {
  assert.match(
    applyMutation,
    /const moderationVersion = moderated \? null : MODERATION_SKIPPED;/,
  );
  assert.match(applyMutation, /!isKossoriSubject\(uri, commit\.record, appviewOnly\)/);
});
