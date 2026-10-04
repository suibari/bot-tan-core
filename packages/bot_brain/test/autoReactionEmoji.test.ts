import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { resetAiRouteCache } from "@bsky-affirmative-bot/shared-configs";
import {
  buildAutoReactionMessages,
  chooseAutoReactionEmoji,
  parseAutoReactionEmoji,
} from "../src/ai/chooseAutoReactionEmoji.js";

const candidates = [
  { key: ":yatta:", description: "やったー" },
  { key: ":otsukare:" },
];

test("候補にある値だけを受け付ける", () => {
  assert.equal(parseAutoReactionEmoji('{"emoji":":yatta:"}', candidates), ":yatta:");
  assert.equal(parseAutoReactionEmoji('{"emoji":" :otsukare: "}', candidates), ":otsukare:");
  for (const raw of ["", "not json", "null", '{"emoji":":other:"}', '{"emoji":1}', "{}"])
    assert.equal(parseAutoReactionEmoji(raw, candidates), null, raw);
});

test("候補は指示側、投稿はいちばん後ろに置く", () => {
  const messages = buildAutoReactionMessages("今日はケーキを焼いた", candidates, 32_768);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /- :yatta:（やったー）/);
  assert.match(messages[0].content, /- :otsukare:$/m);
  assert.equal(messages.at(-1)!.role, "user");
  assert.match(messages.at(-1)!.content, /今日はケーキを焼いた\n<\/post>$/);
});

test("空の本文・空の候補では Ollama を呼ばない", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  try {
    assert.equal(await chooseAutoReactionEmoji("  ", candidates), null);
    assert.equal(await chooseAutoReactionEmoji("うれしい", []), null);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test("num_ctx を送らず、temperature と num_predict と候補の enum を送る", async () => {
  const previous = { base: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.OLLAMA_MODEL = "local-test-model";
  let body: any;
  const fetchMock = mock.method(globalThis, "fetch", async (_input: any, init: any) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ message: { content: '{"emoji":":yatta:"}' } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    assert.equal(await chooseAutoReactionEmoji("資格に合格した！", candidates), ":yatta:");
    assert.equal("num_ctx" in body.options, false);
    assert.equal(typeof body.options.temperature, "number");
    assert.ok(body.options.temperature > 0);
    assert.equal(typeof body.options.num_predict, "number");
    assert.deepEqual(body.format.properties.emoji.enum, [":yatta:", ":otsukare:"]);
    assert.match(body.messages.at(-1).content, /資格に合格した！/);
  } finally {
    fetchMock.mock.restore();
    if (previous.base === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous.model;
  }
});

test("ルートがローカル以外なら投稿を外へ出さずに投げる", async () => {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    route: process.env.AI_ROUTE_NAGI_AUTO_REACTION,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  process.env.AI_ROUTE_NAGI_AUTO_REACTION = "lite-standard";
  resetAiRouteCache();
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });
  try {
    await assert.rejects(chooseAutoReactionEmoji("うれしい", candidates), /local Ollama/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
    for (const [key, value] of [
      ["OLLAMA_BASE_URL", previous.base],
      ["AI_ROUTE_NAGI_AUTO_REACTION", previous.route],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAiRouteCache();
  }
});
