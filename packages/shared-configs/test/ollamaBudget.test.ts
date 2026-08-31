import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OLLAMA_BUDGET_SAFETY_MARGIN,
  OLLAMA_DEFAULT_OUTPUT_TOKENS,
  OLLAMA_IMAGE_TOKEN_COST,
  OLLAMA_MIN_OUTPUT_TOKENS,
  estimateMessagesTokens,
  estimateTokens,
  ollamaPromptBudget,
} from "../src/config/ollamaBudget.js";
import {
  DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH,
  ollamaTextContextLength,
  resetAiRouteCache,
} from "../src/config/aiRoutes.js";

test("日本語はASCIIより多くのトークンとして見積もる", () => {
  // 同じ文字数でも日本語の方がトークンを食う。逆になると予算が甘くなって事故が再発する。
  assert.ok(estimateTokens("あいうえおかきくけこ") > estimateTokens("abcdefghij"));
});

test("見積もりは文字数に対して単調増加する", () => {
  const short = estimateTokens("こんにちは");
  const long = estimateTokens("こんにちは".repeat(10));
  assert.ok(long > short);
  assert.equal(estimateTokens(""), 0);
});

test("絵文字はBMP文字より重く数える", () => {
  assert.ok(estimateTokens("🦊") > estimateTokens("狐"));
});

test("画像は文字数に現れないので枚数ぶん加算する", () => {
  const withoutImage = estimateMessagesTokens([{ content: "look" }]);
  const withImage = estimateMessagesTokens([{ content: "look", images: ["BASE64"] }]);
  assert.ok(withImage - withoutImage >= OLLAMA_IMAGE_TOKEN_COST);
});

test("予算は出力枠と安全マージンを必ず引く", () => {
  const budget = ollamaPromptBudget({ numCtx: 32_768, outputTokens: 1_024 });
  assert.equal(budget, 32_768 - 1_024 - OLLAMA_BUDGET_SAFETY_MARGIN);
  assert.ok(budget < 32_768);
});

test("出力枠の指定が小さすぎても最低枠を確保する", () => {
  const budget = ollamaPromptBudget({ numCtx: 8_192, outputTokens: 1 });
  assert.equal(budget, 8_192 - OLLAMA_MIN_OUTPUT_TOKENS - OLLAMA_BUDGET_SAFETY_MARGIN);
});

test("出力枠の未指定時は投稿用の既定を取り置く", () => {
  assert.equal(
    ollamaPromptBudget({ numCtx: 32_768 }),
    32_768 - OLLAMA_DEFAULT_OUTPUT_TOKENS - OLLAMA_BUDGET_SAFETY_MARGIN,
  );
});

test("予算が負になる設定でも0で止める", () => {
  assert.equal(ollamaPromptBudget({ numCtx: 100, outputTokens: 1_024 }), 0);
});

test("num_ctxはenvで上書きでき、不正値は既定へ落ちる", () => {
  const saved = process.env.OLLAMA_TEXT_CONTEXT_LENGTH;
  try {
    delete process.env.OLLAMA_TEXT_CONTEXT_LENGTH;
    resetAiRouteCache();
    assert.equal(ollamaTextContextLength(), DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH);

    process.env.OLLAMA_TEXT_CONTEXT_LENGTH = "16384";
    resetAiRouteCache();
    assert.equal(ollamaTextContextLength(), 16_384);

    // 4096 未満は SYSTEM_INSTRUCTION だけで溢れるので受け付けない。
    process.env.OLLAMA_TEXT_CONTEXT_LENGTH = "512";
    resetAiRouteCache();
    assert.equal(ollamaTextContextLength(), DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH);

    process.env.OLLAMA_TEXT_CONTEXT_LENGTH = "not-a-number";
    resetAiRouteCache();
    assert.equal(ollamaTextContextLength(), DEFAULT_OLLAMA_TEXT_CONTEXT_LENGTH);
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_TEXT_CONTEXT_LENGTH;
    else process.env.OLLAMA_TEXT_CONTEXT_LENGTH = saved;
    resetAiRouteCache();
  }
});
