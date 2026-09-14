import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeatureIntentSchema,
  classifyFeatureIntentOllama,
  detectFeatureIntentsByKeyword,
  featureIntentCandidates,
  parseFeatureIntentOutput,
  resolveFeatureIntents,
  type FeatureIntent,
  type LlmFeatureIntentOutput,
} from "../src/features/featureIntent.js";

const called = (text: string, isCommunityMember = false) => ({
  text,
  isReplyOrMentionToMe: true,
  isCommunityMember,
});

const sorted = (intents: ReadonlySet<FeatureIntent>) => [...intents].sort();

test("regex: 呼ばれていてトリガーワードを含むときだけ発火する", () => {
  assert.deepEqual(sorted(detectFeatureIntentsByKeyword(called("占って！")).intents), ["fortune"]);
  assert.deepEqual(
    sorted(detectFeatureIntentsByKeyword({ ...called("占って！"), isReplyOrMentionToMe: false }).intents),
    [],
  );
  // 愛称呼びは呼ばれた扱い
  assert.deepEqual(
    sorted(detectFeatureIntentsByKeyword({ ...called("botたん DJお願い"), isReplyOrMentionToMe: false }).intents),
    ["dj"],
  );
});

test("regex: 日記と応援は呼ばれていなくてもコミュニティメンバーなら発火する", () => {
  const notCalled = { text: "日記つけて #全肯定応援団", isReplyOrMentionToMe: false, isCommunityMember: true };
  assert.deepEqual(sorted(detectFeatureIntentsByKeyword(notCalled).intents), ["cheer", "diary_on"]);
  assert.deepEqual(
    sorted(detectFeatureIntentsByKeyword({ ...notCalled, isCommunityMember: false }).intents),
    [],
  );
});

test("regex: 解除トリガーは設定トリガーも含むので両方返す（機能側で解除を優先する）", () => {
  assert.deepEqual(
    sorted(detectFeatureIntentsByKeyword(called("定型文モード解除")).intents),
    ["predefined_mode_off", "predefined_mode_on"],
  );
});

test("regex: freqN は 0〜100 のときだけ頻度変更になる", () => {
  const ok = detectFeatureIntentsByKeyword(called("freq30"));
  assert.deepEqual(sorted(ok.intents), ["reply_frequency"]);
  assert.equal(ok.replyFrequency, 30);
  assert.deepEqual(sorted(detectFeatureIntentsByKeyword(called("freq150")).intents), []);
  // 旧実装の /g 付き正規表現は lastIndex が残って2回目に失敗していた
  assert.equal(detectFeatureIntentsByKeyword(called("FREQ5")).replyFrequency, 5);
  assert.equal(detectFeatureIntentsByKeyword(called("FREQ5")).replyFrequency, 5);
});

test("llm候補: 呼ばれていない投稿はトリガーワードのある機能だけ、コミュニティ限定は除外", () => {
  assert.deepEqual(
    featureIntentCandidates({ text: "今日は疲れた", isReplyOrMentionToMe: false, isCommunityMember: true }),
    [],
  );
  assert.deepEqual(
    featureIntentCandidates({ text: "日記つけて", isReplyOrMentionToMe: false, isCommunityMember: true }),
    ["diary_on"],
  );
  const nonMember = featureIntentCandidates(called("今日の運勢みて"));
  assert.ok(nonMember.includes("fortune"));
  for (const intent of ["diary_on", "cheer", "recap", "anniversary_register"] as const) {
    assert.ok(!nonMember.includes(intent), intent);
  }
  // 応援はハッシュタグが前提
  assert.ok(!featureIntentCandidates(called("拡散して", true)).includes("cheer"));
  assert.ok(featureIntentCandidates(called("#全肯定応援団 見て", true)).includes("cheer"));
});

test("llm: 候補が無ければ LLM を呼ばない", async () => {
  let calls = 0;
  const result = await resolveFeatureIntents(
    { text: "今日は疲れた", isReplyOrMentionToMe: false, isCommunityMember: false },
    { detector: "llm", isOllamaConfigured: () => true, classify: async () => { calls++; return { feature: "none" }; } },
  );
  assert.equal(calls, 0);
  assert.deepEqual(sorted(result.intents), []);
});

test("llm: 重複したトリガーでも LLM が選んだ1つだけを返す", async () => {
  let seen: readonly FeatureIntent[] = [];
  const result = await resolveFeatureIntents(called("占ってほしいけど、その前に分析して"), {
    detector: "llm",
    isOllamaConfigured: () => true,
    classify: async (_text, candidates) => {
      seen = candidates;
      return { feature: "analyze" };
    },
  });
  assert.ok(seen.includes("fortune") && seen.includes("analyze"));
  assert.equal(result.detector, "llm");
  assert.deepEqual(sorted(result.intents), ["analyze"]);
});

test("llm: none ならトリガーワードを含んでも発火しない", async () => {
  const result = await resolveFeatureIntents(called("昨日、友達に占ってもらった"), {
    detector: "llm",
    isOllamaConfigured: () => true,
    classify: async () => ({ feature: "none" }),
  });
  assert.deepEqual(sorted(result.intents), []);
});

test("llm: 頻度と記念日の抽出値を返し、頻度が取れなければ発火しない", async () => {
  const withValue = (output: LlmFeatureIntentOutput) =>
    resolveFeatureIntents(called("リプの頻度を3割にして", true), {
      detector: "llm",
      isOllamaConfigured: () => true,
      classify: async () => output,
    });
  const freq = await withValue({ feature: "reply_frequency", replyFrequency: 30 });
  assert.deepEqual(sorted(freq.intents), ["reply_frequency"]);
  assert.equal(freq.replyFrequency, 30);
  assert.deepEqual(sorted((await withValue({ feature: "reply_frequency", replyFrequency: null })).intents), []);
  assert.deepEqual(sorted((await withValue({ feature: "reply_frequency", replyFrequency: 101 })).intents), []);

  const anniv = await withValue({
    feature: "anniversary_register",
    anniversaryName: "結婚記念日",
    anniversaryDate: "06-01",
  });
  assert.deepEqual(anniv.anniversary, { name: "結婚記念日", date: "06-01" });
});

test("llm: 失敗や未設定のときはトリガーワード判定へ落とす", async () => {
  const failed = await resolveFeatureIntents(called("占って"), {
    detector: "llm",
    isOllamaConfigured: () => true,
    classify: async () => { throw new Error("timeout"); },
  });
  assert.equal(failed.detector, "regex");
  assert.equal(failed.fallbackReason, "timeout");
  assert.deepEqual(sorted(failed.intents), ["fortune"]);

  const unconfigured = await resolveFeatureIntents(called("占って"), {
    detector: "llm",
    isOllamaConfigured: () => false,
    classify: async () => { throw new Error("must not be called"); },
  });
  assert.equal(unconfigured.detector, "regex");
  assert.deepEqual(sorted(unconfigured.intents), ["fortune"]);
});

test("regex モードは LLM を呼ばない", async () => {
  const result = await resolveFeatureIntents(called("占って"), {
    detector: "regex",
    isOllamaConfigured: () => true,
    classify: async () => { throw new Error("must not be called"); },
  });
  assert.deepEqual(sorted(result.intents), ["fortune"]);
});

test("LLM出力のパースは候補外の機能を拒否する", () => {
  assert.throws(() => parseFeatureIntentOutput('{"feature":"recap"}', ["fortune"]));
  assert.deepEqual(parseFeatureIntentOutput('{"feature":"fortune"}', ["fortune"]).feature, "fortune");
});

test("スキーマは候補に応じて抽出欄を足す", () => {
  assert.deepEqual(buildFeatureIntentSchema(["fortune"]).required, ["feature"]);
  assert.deepEqual(
    buildFeatureIntentSchema(["reply_frequency", "anniversary_register"]).required,
    ["feature", "reply_frequency", "anniversary_name", "anniversary_date"],
  );
});

test("Ollama へのリクエストは num_ctx を送らず temperature と format を載せ、投稿を最後に置く", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { base: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL };
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.OLLAMA_MODEL = "test-model";
  let body: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ message: { content: '{"feature":"dj"}' } }), { status: 200 });
  }) as typeof fetch;
  try {
    const output = await classifyFeatureIntentOllama("DJお願い", ["dj", "fortune"]);
    assert.equal(output.feature, "dj");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv.base === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalEnv.base;
    if (originalEnv.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = originalEnv.model;
  }
  assert.equal("num_ctx" in body.options, false);
  assert.equal(typeof body.options.temperature, "number");
  assert.equal(typeof body.options.num_predict, "number");
  assert.deepEqual(body.format.properties.feature.enum, ["dj", "fortune", "none"]);
  assert.equal(body.messages.at(-1).role, "user");
  assert.equal(body.messages.at(-1).content, "DJお願い");
});
