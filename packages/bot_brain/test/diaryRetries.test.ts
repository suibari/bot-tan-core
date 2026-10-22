import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAiRouteCache } from "@bsky-affirmative-bot/shared-configs";
import { generateUserDiaryDraft, parseUserDiaryResponse, resolveUserDiaryResponseFormat } from "../src/ai/generateUserDiary.js";
import { generateUserDiaryResilient } from "../src/ai/generateUserDiaryResilient.js";
import { DiaryValidationError } from "../src/ai/diaryValidation.js";
import { saveDiaryDiagnosticSample } from "../src/ai/diaryDiagnosticSamples.js";
import { generateContentWithRetry } from "../src/ai/util.js";

const userinfo = {
  follower: { did: "did:plc:test", handle: "test.example", displayName: "テストさん" },
  posts: ["設定を直した"],
  langStr: "日本語" as const,
};
const excerpt = "冷蔵庫が突然宇宙船の船長になった。";
const valid = {
  diary: `${"今日の具体的な出来事を振り返る。".repeat(150)}\n\n${excerpt}`,
  title_ja: "整備の達人",
  title_en: "Master of Maintenance",
  usedContextId: "none",
  chaosExcerpt: excerpt,
};

async function withOllama(run: (requests: any[], logs: string[]) => Promise<void>, responses: Array<string | Error>) {
  const keys = ["AI_TEXT_PROVIDER", "AI_ROUTE_COMMON_USER_DIARY", "OLLAMA_BASE_URL", "DIARY_DIAGNOSTICS_DIR"];
  const saved = keys.map((key) => process.env[key]);
  process.env.AI_TEXT_PROVIDER = "ollama";
  process.env.AI_ROUTE_COMMON_USER_DIARY = "ollama-chat";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  delete process.env.DIARY_DIAGNOSTICS_DIR;
  resetAiRouteCache();
  const requests: any[] = [];
  const logs: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    const response = responses[requests.length - 1];
    assert.notEqual(response, undefined, "unexpected extra LLM request");
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify({
      message: { content: response }, model: "test-model", prompt_eval_count: 100,
      eval_count: 50, total_duration: 2_000_000_000, done_reason: "stop",
    }), { status: 200 });
  });
  const info = mock.method(console, "info", (...args: unknown[]) => { logs.push(args.join(" ")); });
  try {
    await run(requests, logs);
  } finally {
    fetchMock.mock.restore();
    info.mock.restore();
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    resetAiRouteCache();
  }
}

test("long diary JSON succeeds with one native request and preserves output settings", async () => {
  assert.ok(JSON.stringify(valid).length > 2100);
  await withOllama(async (requests, logs) => {
    const result = await generateUserDiaryResilient(userinfo, {
      label: "[TEST][DIARY]", surface: "bsky", responseFormat: "excerpt",
      dayContext: { date: "2026-10-22", preferredKind: "news", candidates: [] },
    });
    assert.equal(result.diary, valid.diary);
    assert.equal(requests.length, 1);
    const options = requests[0].options;
    assert.equal(options.num_predict, 1024);
    assert.ok(options.temperature > 0);
    assert.equal("num_ctx" in options, false);
    assert.equal("maxTextLength" in requests[0], false);
    assert.equal(logs.filter((line) => line.includes(" diary_ai_request ")).length, 1);
    assert.equal(logs.filter((line) => line.includes(" diary_ai_call ")).length, 1);
    assert.match(logs.find((line) => line.includes(" diary_ai_call "))!, /truncated=false output_limit=1024 ollama_total_ms=2000/);
    assert.match(logs.find((line) => line.includes(" diary_run "))!, /surface=bsky subject=did:plc:test date=2026-10-22 format=excerpt attempts=1 calls=1 responses=1 .*completed=true/);
    assert.ok(logs.every((line) => !line.includes(excerpt)));
  }, [JSON.stringify(valid)]);
});

test("ordinary posts retain their length retry and all callbacks fire", async () => {
  await withOllama(async (requests) => {
    let started = 0;
    const usages: number[] = [];
    await generateContentWithRetry({ feature: "COMMON_USER_DIARY", contents: ["test"] }, 1, undefined, {
      onRequest: () => { started++; },
      onUsage: (usage) => { usages.push(usage.promptTokens); },
    });
    assert.equal(requests.length, 2);
    assert.equal(started, 2);
    assert.deepEqual(usages, [100, 100]);
  }, ["x".repeat(2200), "short"]);
});

test("flagged paragraphs pass through the native schema and render only text", async () => {
  const response = {
    paragraphs: [{ text: "今日は設定を直したんだね。", containsChaos: false }, { text: excerpt, containsChaos: true }],
    title_ja: valid.title_ja, title_en: valid.title_en, usedContextId: "none",
  };
  await withOllama(async (requests) => {
    const result = await generateUserDiaryDraft(userinfo);
    assert.equal(result.diary, response.paragraphs.map((part) => part.text).join("\n\n"));
    assert.equal(result.chaosExcerpt, excerpt);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].format.properties.paragraphs.items.properties.containsChaos.type, "boolean");
    assert.equal("chaosExcerpt" in requests[0].format.properties, false);
    assert.equal("num_ctx" in requests[0].options, false);
    assert.equal(requests[0].options.num_predict, 1024);
    assert.ok(requests[0].options.temperature > 0);
  }, [JSON.stringify(response)]);
});

test("only the evaluated Ollama route adopts paragraph flags by default", async () => {
  await withOllama(async () => {
    assert.equal(resolveUserDiaryResponseFormat(), "paragraphFlags");
    assert.equal(resolveUserDiaryResponseFormat("excerpt"), "excerpt");
    process.env.AI_ROUTE_COMMON_USER_DIARY = "35-lite-flex";
    process.env.AI_TEXT_PROVIDER = "gemini";
    resetAiRouteCache();
    assert.equal(resolveUserDiaryResponseFormat(), "excerpt");
  }, []);
});

test("excerpt mismatch remains invalid and reports content-free diagnostics across retry", async () => {
  await withOllama(async (requests, logs) => {
    await generateUserDiaryResilient(userinfo, { label: "[TEST][DIARY]", responseFormat: "excerpt", sleep: async () => {} });
    assert.equal(requests.length, 2);
    const attempts = logs.filter((line) => line.includes(" diary_ai operation="));
    assert.match(attempts[0], /valid=false reason=excerpt_mismatch/);
    assert.match(attempts[1], /valid=true reason=ok/);
    assert.match(logs.find((line) => line.includes(" diary_validation "))!, /whitespace_match=true nfc_match=false/);
    assert.match(logs.find((line) => line.includes(" diary_run "))!, /attempts=2 calls=2 responses=2 input_tokens=200 output_tokens=100/);
    const ids = logs.map((line) => line.match(/run_id=([^ ]+)/)?.[1]).filter(Boolean);
    assert.equal(new Set(ids).size, 1);
    assert.ok(logs.every((line) => !line.includes(excerpt)));
  }, [JSON.stringify({ ...valid, chaosExcerpt: excerpt.replace("突然", "突 然") }), JSON.stringify(valid)]);
});

test("transport failure counts as a request even without usage", async () => {
  await withOllama(async (requests, logs) => {
    await generateUserDiaryResilient(userinfo, { label: "[TEST][DIARY]", responseFormat: "excerpt", sleep: async () => {} });
    assert.equal(requests.length, 2);
    assert.equal(logs.filter((line) => line.includes(" diary_ai_call ")).length, 1);
    assert.match(logs.find((line) => line.includes(" diary_run "))!, /calls=2 responses=1/);
  }, [Object.assign(new Error("connection reset"), { code: "ECONNRESET" }), JSON.stringify(valid)]);
});

test("all usage callbacks are retained instead of overwriting earlier calls", async () => {
  const logs: string[] = [];
  const info = mock.method(console, "info", (...args: unknown[]) => { logs.push(args.join(" ")); });
  try {
    await generateUserDiaryResilient(userinfo, {
      label: "[TEST][DIARY]",
      generateDraft: async (_user, options) => {
        for (let i = 0; i < 2; i++) {
          options.onRequest?.();
          options.onUsage?.({ model: "test", promptTokens: 10, outputTokens: 20, thinkingTokens: 3, totalTokens: 33, latencyMs: 5 });
        }
        return valid;
      },
    });
    assert.equal(logs.filter((line) => line.includes(" diary_ai_call ")).length, 2);
    assert.match(logs.find((line) => line.includes(" diary_ai operation="))!, /calls=2 .*latency_ms=10 input_tokens=20 output_tokens=40 thinking_tokens=6 total_tokens=66/);
  } finally { info.mock.restore(); }
});

test("JSON, paragraphs, context, title and excerpt protections keep stable reason codes", () => {
  const cases: Array<[string, string]> = [
    ["{", "invalid_json"],
    ["null", "invalid_shape"],
    [JSON.stringify({ ...valid, diary: 12 }), "invalid_shape"],
    [JSON.stringify({ ...valid, diary: "one paragraph" }), "paragraphs"],
    [JSON.stringify({ ...valid, usedContextId: "fake" }), "context_id"],
    [JSON.stringify({ ...valid, title_ja: "多動の旅人" }), "title"],
    [JSON.stringify({ ...valid, chaosExcerpt: 10 }), "excerpt_type"],
    [JSON.stringify({ ...valid, chaosExcerpt: "短い" }), "excerpt_short"],
    [JSON.stringify({ ...valid, chaosExcerpt: "本文に存在しない十分長い別の文章" }), "excerpt_mismatch"],
  ];
  for (const [text, reason] of cases) {
    assert.throws(() => parseUserDiaryResponse(text), (error) => error instanceof DiaryValidationError && error.reason === reason);
  }
});

test("exhausted validation retries emit an unsuccessful run summary", async () => {
  const bad = JSON.stringify({ ...valid, chaosExcerpt: "short" });
  await withOllama(async (requests, logs) => {
    await assert.rejects(generateUserDiaryResilient(userinfo, {
      label: "[TEST][DIARY]", responseFormat: "excerpt", sleep: async () => {},
    }), (error) => error instanceof DiaryValidationError && error.reason === "excerpt_short");
    assert.equal(requests.length, 5);
    assert.match(logs.find((line) => line.includes(" diary_run "))!, /attempts=5 calls=5 responses=5 .*completed=false/);
  }, Array(5).fill(bad));
});

test("a rejected response is sampled only when enabled and keeps its run identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diary-rejected-"));
  const savedUntil = process.env.DIARY_DIAGNOSTICS_UNTIL;
  const bad = JSON.stringify({ ...valid, chaosExcerpt: "short" });
  try {
    await withOllama(async () => {
      process.env.DIARY_DIAGNOSTICS_DIR = dir;
      process.env.DIARY_DIAGNOSTICS_UNTIL = new Date(Date.now() + 60_000).toISOString();
      await assert.rejects(generateUserDiaryDraft(userinfo, {
        responseFormat: "excerpt",
        diagnosticContext: { runId: "sample-test", attempt: 2, surface: "nagi" },
      }), DiaryValidationError);
      const sample = JSON.parse(await readFile(join(dir, "diary-failure-00.json"), "utf8"));
      assert.equal(sample.responseText, bad);
      assert.equal(sample.runId, "sample-test");
      assert.equal(sample.attempt, 2);
      assert.equal(sample.reason, "excerpt_short");
    }, [bad]);
  } finally {
    if (savedUntil === undefined) delete process.env.DIARY_DIAGNOSTICS_UNTIL;
    else process.env.DIARY_DIAGNOSTICS_UNTIL = savedUntil;
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostic samples require a future deadline, stop at 20 slots and use private permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diary-diagnostics-"));
  const savedDir = process.env.DIARY_DIAGNOSTICS_DIR;
  const savedUntil = process.env.DIARY_DIAGNOSTICS_UNTIL;
  try {
    process.env.DIARY_DIAGNOSTICS_DIR = dir;
    delete process.env.DIARY_DIAGNOSTICS_UNTIL;
    await saveDiaryDiagnosticSample({ responseText: "private" });
    assert.deepEqual(await readdir(dir), []);
    process.env.DIARY_DIAGNOSTICS_UNTIL = new Date(Date.now() - 1000).toISOString();
    await saveDiaryDiagnosticSample({ responseText: "private" });
    assert.deepEqual(await readdir(dir), []);
    process.env.DIARY_DIAGNOSTICS_UNTIL = new Date(Date.now() + 60_000).toISOString();
    await Promise.all(Array.from({ length: 25 }, (_, index) => saveDiaryDiagnosticSample({ index, responseText: "private" })));
    const files = await readdir(dir);
    assert.equal(files.length, 20);
    for (const file of files) {
      const path = join(dir, file);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(JSON.parse(await readFile(path, "utf8")).responseText, "private");
    }
  } finally {
    if (savedDir === undefined) delete process.env.DIARY_DIAGNOSTICS_DIR;
    else process.env.DIARY_DIAGNOSTICS_DIR = savedDir;
    if (savedUntil === undefined) delete process.env.DIARY_DIAGNOSTICS_UNTIL;
    else process.env.DIARY_DIAGNOSTICS_UNTIL = savedUntil;
    await rm(dir, { recursive: true, force: true });
  }
});
