import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { gemini } from "../src/ai/index.js";
import { judgePositiveNewsBatch, sanitizeGateDecisions } from "../src/ai/judgePositiveNewsBatch.js";
import { withNewsGeminiRetry } from "../src/ai/newsGeminiRetry.js";
import { resetAiRouteCache } from "@bsky-affirmative-bot/shared-configs";

const savedTextProvider = process.env.AI_TEXT_PROVIDER;
test.beforeEach(() => {
  process.env.AI_TEXT_PROVIDER = "gemini";
  resetAiRouteCache();
});
test.afterEach(() => {
  if (savedTextProvider === undefined) delete process.env.AI_TEXT_PROVIDER;
  else process.env.AI_TEXT_PROVIDER = savedTextProvider;
  resetAiRouteCache();
});

const input = [
  { articleId: "a", title: "受賞", categories: [] },
  { articleId: "b", title: "復旧", categories: [] },
];
const decision = (articleId: string) => ({ articleId, publishable: true, reasonCode: "positive_result" });

test("入力外・欠落・重複IDをfail closedにする", () => {
  const result = sanitizeGateDecisions(input, [decision("a"), decision("a"), decision("unknown")]);
  assert.deepEqual(result.map((item) => item.publishable), [false, false]);
});

test("不正なreasonCode/publishableは掲載しない", () => {
  const result = sanitizeGateDecisions(input.slice(0, 1), [{ articleId: "a", publishable: true, reasonCode: "bogus" }]);
  assert.equal(result[0].publishable, false);
  assert.equal(result[0].reasonCode, "unclear");
});

const silentLogger = { warn: () => undefined };
const fastRetryOptions = { minTimeout: 1, randomize: false, logger: silentLogger };

test("一時的な503は合計3回まで試行して成功する", async () => {
  let attempts = 0;
  const result = await withNewsGeminiRetry(
    { stage: "gate" },
    async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("high demand"), { status: 503 });
      return "ok";
    },
    fastRetryOptions,
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("503が継続した場合は3回試行して503を送出する", async () => {
  let attempts = 0;
  await assert.rejects(
    withNewsGeminiRetry(
      { stage: "gate" },
      async () => {
        attempts++;
        throw Object.assign(new Error("unavailable"), { status: 503 });
      },
      fastRetryOptions,
    ),
    (error: any) => error?.status === 503,
  );
  assert.equal(attempts, 3);
});

test("400は再試行せず、通信TypeErrorは再試行する", async () => {
  let badRequestAttempts = 0;
  await assert.rejects(
    withNewsGeminiRetry(
      { stage: "gate" },
      async () => {
        badRequestAttempts++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      fastRetryOptions,
    ),
  );
  assert.equal(badRequestAttempts, 1);

  let networkAttempts = 0;
  const result = await withNewsGeminiRetry(
    { stage: "gate" },
    async () => {
      networkAttempts++;
      if (networkAttempts === 1) throw new TypeError("fetch failed");
      return "recovered";
    },
    fastRetryOptions,
  );
  assert.equal(result, "recovered");
  assert.equal(networkAttempts, 2);

  let programmingErrorAttempts = 0;
  await assert.rejects(
    withNewsGeminiRetry(
      { stage: "gate" },
      async () => {
        programmingErrorAttempts++;
        throw new TypeError("Cannot read properties of undefined");
      },
      fastRetryOptions,
    ),
  );
  assert.equal(programmingErrorAttempts, 1);
});

test("ゲートのJSON再生成と通信リトライを独立して行う", async () => {
  const candidate = { articleId: "gate-a", title: "明るい話題", categories: [] };
  let calls = 0;
  const generateContent = mock.method(gemini.models, "generateContent", async () => {
    calls++;
    if (calls === 1) return { text: "not json" } as any;
    if (calls === 2) throw Object.assign(new Error("high demand"), { status: 503 });
    return {
      text: JSON.stringify({
        decisions: [{ articleId: candidate.articleId, publishable: false, reasonCode: "unclear" }],
      }),
    } as any;
  });

  try {
    const result = await judgePositiveNewsBatch([candidate]);
    assert.equal(calls, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].publishable, false);
  } finally {
    generateContent.mock.restore();
  }
});

test("コメント生成は同時2件までで入力順を維持する", async () => {
  const candidates = Array.from({ length: 5 }, (_, index) => ({
    articleId: `comment-${index}`,
    title: `明るい話題${index}`,
    link: `https://example.com/${index}`,
    categories: [],
  }));
  let activeComments = 0;
  let maxActiveComments = 0;
  const generateContent = mock.method(gemini.models, "generateContent", async (params: any) => {
    if (params.config?.responseSchema) {
      return {
        text: JSON.stringify({
          decisions: candidates.map((candidate) => ({
            articleId: candidate.articleId,
            publishable: true,
            reasonCode: "positive_result",
          })),
        }),
      } as any;
    }

    activeComments++;
    maxActiveComments = Math.max(maxActiveComments, activeComments);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        text: JSON.stringify({
          botCommentJa: "うれしいニュースだね！",
          titleEn: "Good News",
          botCommentEn: "This is happy news!",
        }),
      } as any;
    } finally {
      activeComments--;
    }
  });

  try {
    const result = await judgePositiveNewsBatch(candidates);
    assert.equal(maxActiveComments, 2);
    assert.deepEqual(result.map((item) => item.articleId), candidates.map((item) => item.articleId));
    assert.ok(result.every((item) => item.publishable));
  } finally {
    generateContent.mock.restore();
  }
});
