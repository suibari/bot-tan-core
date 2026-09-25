import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  estimateMessagesTokens,
  ollamaPromptBudget,
  resetAiRouteCache,
} from "@bsky-affirmative-bot/shared-configs";
import {
  buildPostMoodMessages,
  parsePostMood,
  scorePostMood,
} from "../src/ai/scorePostMood.js";

test("気分の出力は -5〜+5 の整数と真偽値だけを受け付ける", () => {
  assert.deepEqual(parsePostMood('{"valence":3,"expressive":true}'), {
    valence: 3,
    expressive: true,
  });
  assert.deepEqual(parsePostMood('{"valence":-5,"expressive":true}'), {
    valence: -5,
    expressive: true,
  });
  for (const raw of [
    "",
    "not json",
    '{"valence":6,"expressive":true}',
    '{"valence":-6,"expressive":true}',
    '{"valence":2.5,"expressive":true}',
    '{"valence":"3","expressive":true}',
    '{"valence":3}',
    "null",
  ])
    assert.equal(parsePostMood(raw), null, raw);
});

test("0 は気分が読めても中立として扱う", () => {
  assert.deepEqual(parsePostMood('{"valence":0,"expressive":true}'), {
    valence: 0,
    expressive: false,
  });
});

test("空の本文は Ollama を呼ばずに採点不能を返す", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  try {
    assert.equal(await scorePostMood("  \n "), null);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("投稿はプロンプトの最後に置き、温度0・構造化出力で採点する", async () => {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.OLLAMA_MODEL = "local-test-model";
  let body: any;
  const fetchMock = mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ message: { content: '{"valence":-3,"expressive":true}' } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    assert.deepEqual(await scorePostMood("足が痛くてしんどい"), {
      valence: -3,
      expressive: true,
    });
    const last = body.messages.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content, /足が痛くてしんどい/);
    assert.equal(body.options.temperature, 0);
    assert.equal("num_ctx" in body.options, false);
    assert.equal(typeof body.options.num_predict, "number");
    assert.deepEqual(body.format.required, ["valence", "expressive"]);
  } finally {
    fetchMock.mock.restore();
    if (previous.base === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
  }
});

test("採点ルートが env でローカル以外へ向いていたら Ollama を呼ばずに投げる", async () => {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
    route: process.env.AI_ROUTE_NAGI_POST_MOOD,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.OLLAMA_MODEL = "local-test-model";
  process.env.AI_ROUTE_NAGI_POST_MOOD = "lite-standard";
  resetAiRouteCache();
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  try {
    await assert.rejects(scorePostMood("うれしい！"), /local Ollama/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
    for (const [key, value] of [
      ["OLLAMA_BASE_URL", previous.base],
      ["OLLAMA_MODEL", previous.model],
      ["AI_ROUTE_NAGI_POST_MOOD", previous.route],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAiRouteCache();
  }
});

test("プロンプトは出力枠を残して num_ctx の予算に収め、指示は削らない", () => {
  const body = "しんどい。".repeat(400);
  const roomy = buildPostMoodMessages(body, 32_768);
  assert.match(roomy.at(-1)!.content, new RegExp(`${body}\\n</post>$`));

  const tight = buildPostMoodMessages(body, 2_048);
  assert.equal(tight[0].role, "system");
  assert.equal(tight[0].content, roomy[0].content);
  const post = tight.at(-1)!;
  assert.equal(post.role, "user");
  assert.ok(post.content.length < roomy.at(-1)!.content.length);
  assert.ok(post.content.length > 0);
  assert.ok(
    estimateMessagesTokens(tight) <= ollamaPromptBudget({ numCtx: 2_048, outputTokens: 40 }),
  );
});
