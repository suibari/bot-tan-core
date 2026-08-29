import assert from "node:assert/strict";
import test from "node:test";
import {
  aiRouteForAttempt,
  classifyAiError,
  formatAiError,
  runWithAiLadder,
  type AiLadderStep,
  type AiRouteDetails,
} from "../src/config/aiRetryLadder.js";
import {
  DEFAULT_OLLAMA_TEXT_MODEL,
  resetAiRouteCache,
} from "../src/config/aiRoutes.js";

const FLASH_35_LITE = "gemini-3.5-flash-lite";

/** 日記の実ラダーそのもの。段の刻みが変わったらここが赤くなる。 */
const DIARY_LADDER: readonly AiLadderStep[] = [
  { untilAttempt: 2, feature: "COMMON_DIARY_ATTEMPT_EARLY" },
  { untilAttempt: 4, feature: "COMMON_DIARY_ATTEMPT_MID" },
  { untilAttempt: 6, feature: "COMMON_DIARY_ATTEMPT_LATE" },
];

const DELAYS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const DEADLINE = 3 * 60 * 60_000;

const silentLogger = { warn: () => undefined };

/** 時計と sleep を差し替えて、待たずに待ち時間だけ記録する。 */
function fakeClock() {
  let current = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    record: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
  };
}

function ladderOptions<T>(overrides: Partial<Parameters<typeof runWithAiLadder<T>>[0]>) {
  return {
    ladder: DIARY_LADDER,
    delaysMs: DELAYS,
    deadlineMs: DEADLINE,
    maxAttempts: 6,
    label: "[TEST]",
    operation: "generateUserDiary",
    random: () => 0.5, // ジッタ中央値 = 係数1.0
    logger: silentLogger,
    ...overrides,
  } as Parameters<typeof runWithAiLadder<T>>[0];
}

const unavailable = () =>
  new Error(
    'got status: 503 Service Unavailable. {"error":{"code":503,"message":"This model is overloaded.","status":"UNAVAILABLE"}}',
  );

async function withGeminiProvider<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = process.env.AI_TEXT_PROVIDER;
  process.env.AI_TEXT_PROVIDER = "gemini";
  resetAiRouteCache();
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.AI_TEXT_PROVIDER;
    else process.env.AI_TEXT_PROVIDER = saved;
    resetAiRouteCache();
  }
}

test("Gemini の 503 は文字列本文からでも一時障害に分類する", () => {
  assert.equal(classifyAiError(unavailable()).category, "transient");
  assert.equal(classifyAiError(unavailable()).status, 503);
  for (const status of [408, 429, 500, 503, 599]) {
    assert.equal(classifyAiError({ status }).category, "transient");
  }
  assert.equal(classifyAiError({ code: "ECONNRESET" }).category, "transient");
  for (const status of [400, 401, 403]) {
    assert.equal(classifyAiError({ status }).category, "permanent");
  }
  assert.equal(classifyAiError(new Error("なにこれ")).category, "unknown");
});

test("cause 連鎖をたどって1行に潰す", () => {
  const error = new Error("outer", { cause: new Error("inner") });
  assert.equal(formatAiError(error), "outer | caused by: inner");
});

test("Gemini切り戻し時は試行回数に応じてFlexからStandardへ上がる", async () => {
  await withGeminiProvider(() => {
    const at = (attempt: number) => aiRouteForAttempt(DIARY_LADDER, attempt);
    assert.deepEqual(at(1), { model: FLASH_35_LITE, serviceTier: "flex" });
    assert.deepEqual(at(2), { model: FLASH_35_LITE, serviceTier: "flex" });
    assert.deepEqual(at(3), { model: FLASH_35_LITE, serviceTier: "standard" });
    assert.deepEqual(at(4), { model: FLASH_35_LITE, serviceTier: "standard" });
    assert.deepEqual(at(5), { model: FLASH_35_LITE, serviceTier: "standard" });
    assert.deepEqual(at(99), { model: FLASH_35_LITE, serviceTier: "standard" });
  });
});

test("Ollama時は再試行ラダーの全段が同じローカルモデルになる", () => {
  const saved = process.env.AI_TEXT_PROVIDER;
  delete process.env.AI_TEXT_PROVIDER;
  resetAiRouteCache();
  try {
    for (const attempt of [1, 2, 3, 4, 5, 99]) {
      assert.deepEqual(aiRouteForAttempt(DIARY_LADDER, attempt), {
        model: DEFAULT_OLLAMA_TEXT_MODEL,
      });
    }
  } finally {
    if (saved === undefined) delete process.env.AI_TEXT_PROVIDER;
    else process.env.AI_TEXT_PROVIDER = saved;
    resetAiRouteCache();
  }
});

test("Gemini切り戻し時は503で段を上げて再試行する", async () => {
  await withGeminiProvider(async () => {
    const clock = fakeClock();
    const seen: AiRouteDetails[] = [];
    const result = await runWithAiLadder(
      ladderOptions<string>({
        now: clock.now,
        sleep: clock.record,
        run: async (route, attempt) => {
          seen.push(route);
          if (attempt < 5) throw unavailable();
          return "ok";
        },
      }),
    );
    assert.equal(result, "ok");
    assert.deepEqual(seen, [
      { model: FLASH_35_LITE, serviceTier: "flex" },
      { model: FLASH_35_LITE, serviceTier: "flex" },
      { model: FLASH_35_LITE, serviceTier: "standard" },
      { model: FLASH_35_LITE, serviceTier: "standard" },
      { model: FLASH_35_LITE, serviceTier: "standard" },
    ]);
    assert.deepEqual(clock.slept, [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000]);
  });
});

test("恒久エラーは段を上げずに1回で諦める", async () => {
  resetAiRouteCache();
  const clock = fakeClock();
  let attempts = 0;

  await assert.rejects(
    runWithAiLadder(
      ladderOptions({
        now: clock.now,
        sleep: clock.record,
        run: async () => {
          attempts++;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
      }),
    ),
    (error: any) => error?.status === 400,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(clock.slept, []);
});

test("分類できないエラーは5回で打ち切る（上位モデルに数回だけ賭ける）", async () => {
  resetAiRouteCache();
  const clock = fakeClock();
  let attempts = 0;

  await assert.rejects(
    runWithAiLadder(
      ladderOptions({
        now: clock.now,
        sleep: clock.record,
        // 空レスポンスや絵文字候補不足はここに落ちる
        run: async () => {
          attempts++;
          throw new Error("generateUserDiary returned empty");
        },
      }),
    ),
    /generateUserDiary returned empty/,
  );
  assert.equal(attempts, 5);
});

test("一時障害でも試行回数の上限で打ち切る", async () => {
  resetAiRouteCache();
  const clock = fakeClock();
  let attempts = 0;

  await assert.rejects(
    runWithAiLadder(
      ladderOptions({
        now: clock.now,
        sleep: clock.record,
        run: async () => {
          attempts++;
          throw unavailable();
        },
      }),
    ),
    /503/,
  );
  assert.equal(attempts, 6);
});

test("次の待機が期限を越えるならそこで打ち切る", async () => {
  resetAiRouteCache();
  const clock = fakeClock();
  let attempts = 0;

  await assert.rejects(
    runWithAiLadder(
      ladderOptions({
        now: clock.now,
        sleep: clock.record,
        // 1回目の失敗時点で期限の直前まで進んでいる
        deadlineMs: 60_000,
        run: async () => {
          attempts++;
          clock.advance(59_000);
          throw unavailable();
        },
      }),
    ),
    /503/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(clock.slept, []);
});

test("ジッタは基準遅延の ±20% に収まる", async () => {
  resetAiRouteCache();
  const clock = fakeClock();

  await assert.rejects(
    runWithAiLadder(
      ladderOptions({
        now: clock.now,
        sleep: clock.record,
        maxAttempts: 3,
        random: () => 0, // 下限
        run: async () => {
          throw unavailable();
        },
      }),
    ),
    /503/,
  );
  assert.deepEqual(clock.slept, [24_000, 96_000]); // 30s * 0.8, 120s * 0.8
});
