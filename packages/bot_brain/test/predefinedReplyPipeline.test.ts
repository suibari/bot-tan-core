import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProductionPredefinedReply,
  createPredefinedReply,
  detectDirectSpecialLabel,
  parsePredefinedReplySelectorMode,
  resolvePredefinedReplySelectorMode,
  type ProductionPredefinedReplyClassification,
} from "../src/predefinedReplyPipeline.js";
import { translatePredefinedAffirmation } from "../src/predefinedAffirmation.js";

const classification = (
  label: ProductionPredefinedReplyClassification["label"],
  llmCalls: number,
): ProductionPredefinedReplyClassification => ({
  method: "rules-ollama-three-way",
  label,
  latencyMs: 12,
  llmCalls,
  specialRule: llmCalls === 0 ? "direct" : null,
});

test("共通パイプラインはrandomを既定にし未知の選択方式を拒否する", () => {
  assert.equal(parsePredefinedReplySelectorMode(undefined), "random");
  assert.equal(parsePredefinedReplySelectorMode("random"), "random");
  assert.equal(parsePredefinedReplySelectorMode("llm"), "llm");
  assert.throws(
    () => parsePredefinedReplySelectorMode("roulette"),
    /must be random or llm/,
  );
  assert.equal(
    resolvePredefinedReplySelectorMode({
      PREDEFINED_REPLY_SELECTOR: "llm",
      BSKY_PREDEFINED_SELECTOR: "random",
    }),
    "llm",
  );
  assert.equal(
    resolvePredefinedReplySelectorMode({
      PREDEFINED_REPLY_SELECTOR: undefined,
      BSKY_PREDEFINED_SELECTOR: "llm",
    }),
    "llm",
  );
});

test("直接挨拶はLLMなし、それ以外は3分類LLMへ渡す", async () => {
  let calls = 0;
  const direct = await classifyProductionPredefinedReply(
    { text: "gm everyone", languageName: "English" },
    {
      classifyThreeWay: async () => {
        calls += 1;
        return "neutral";
      },
    },
  );
  const ordinary = await classifyProductionPredefinedReply(
    { text: "Today was ordinary.", languageName: "English" },
    {
      classifyThreeWay: async () => {
        calls += 1;
        return "neutral";
      },
    },
  );
  assert.equal(direct.label, "morning");
  assert.equal(direct.llmCalls, 0);
  assert.equal(ordinary.label, "neutral");
  assert.equal(ordinary.llmCalls, 1);
  assert.equal(calls, 1);
});

test("引用・伝聞・別義は挨拶ルールで確定しない", () => {
  assert.equal(detectDirectSpecialLabel("My friend said gm to me."), null);
  assert.equal(detectDirectSpecialLabel("GM announced a new vehicle."), null);
  assert.equal(
    detectDirectSpecialLabel("おつかれ、と友達に言われて振り返った。"),
    null,
  );
  assert.equal(
    detectDirectSpecialLabel("Good Night is the title of the song."),
    null,
  );
});

test("3分類LLM障害時はneutralへ倒してエラーを記録する", async () => {
  const result = await classifyProductionPredefinedReply(
    { text: "ordinary", languageName: "English" },
    {
      classifyThreeWay: async () => {
        throw new Error("ollama unavailable");
      },
    },
  );
  assert.equal(result.label, "neutral");
  assert.equal(result.llmCalls, 1);
  assert.match(result.error ?? "", /ollama unavailable/);
});

test("random選択とLLM選択を両サービス共通で切り替えられる", async () => {
  let randomSelectInjected = false;
  let llmSelectInjected = true;
  await createPredefinedReply(
    { text: "おはよう", languageName: "日本語", displayName: "なぎ" },
    { surface: "bsky", selectorMode: "random" },
    {
      classify: async () => classification("morning", 0),
      random: () => 0,
      affirm: async (_input, dependencies) => {
        randomSelectInjected = Boolean(dependencies.select);
        return "おはよう";
      },
    },
  );
  await createPredefinedReply(
    { text: "ordinary", languageName: "English", displayName: "Nagi" },
    { surface: "nagi", selectorMode: "llm" },
    {
      classify: async () => classification("neutral", 1),
      affirm: async (_input, dependencies) => {
        llmSelectInjected = Boolean(dependencies.select);
        return "All good.";
      },
    },
  );
  assert.equal(randomSelectInjected, true);
  assert.equal(llmSelectInjected, false);
});

test("日英以外は英語定型文を対象言語へ翻訳する", async () => {
  let targetLanguage = "";
  let sourceTemplate = "";
  const reply = await createPredefinedReply(
    { text: "hola", languageName: "Spanish", displayName: "Nagi" },
    { surface: "nagi", selectorMode: "random" },
    {
      classify: async () => classification("neutral", 1),
      random: () => 0,
      translate: async (template, target) => {
        sourceTemplate = template;
        targetLanguage = target;
        return "Todo bien, ${name}.";
      },
    },
  );
  assert.match(sourceTemplate, /[A-Za-z]/);
  assert.equal(targetLanguage, "Spanish");
  assert.equal(reply, "Todo bien, Nagi.");
});

test("定型文翻訳は分類モデルではなく翻訳専用モデルを使う", async () => {
  const original = {
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
    translationModel: process.env.OLLAMA_TRANSLATION_MODEL,
    fetch: globalThis.fetch,
  };
  let requestedModel = "";
  let requestedUrl = "";
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  process.env.OLLAMA_MODEL = "classification-test";
  process.env.OLLAMA_TRANSLATION_MODEL = "translation-test";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedModel = String(JSON.parse(String(init?.body)).model);
    // Ollamaネイティブ /api/chat の応答形。
    return new Response(JSON.stringify({ message: { content: "Hola" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.equal(await translatePredefinedAffirmation("Hello", "Spanish"), "Hola");
    assert.equal(requestedModel, "translation-test");
    assert.equal(requestedUrl, "http://ollama.test/api/chat");
  } finally {
    if (original.baseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = original.baseUrl;
    if (original.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = original.model;
    if (original.translationModel === undefined) {
      delete process.env.OLLAMA_TRANSLATION_MODEL;
    } else {
      process.env.OLLAMA_TRANSLATION_MODEL = original.translationModel;
    }
    globalThis.fetch = original.fetch;
  }
});
