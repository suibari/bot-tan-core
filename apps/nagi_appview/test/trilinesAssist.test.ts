import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_APPVIEW_DID ??= "did:web:localhost";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const {
  emptyLineIndexes,
  fillTrilines,
  generateTrilinesAssist,
  normalizeTrilinesLine,
  parseTrilinesAssistInput,
  requestTrilinesAssist,
  trilinesAssistPrompt,
} = await import("../src/services/trilinesAssist.js");

const body = (overrides: Record<string, unknown> = {}) => ({
  from: "2026-11-02T03:00:00.000Z",
  to: "2026-11-03T03:00:00.000Z",
  lines: ["", "猫をなでた", ""],
  lang: "ja",
  ...overrides,
});

test("入力を検証する", () => {
  const input = parseTrilinesAssistInput(body());
  assert.equal(input.lang, "ja");
  assert.deepEqual(input.lines, ["", "猫をなでた", ""]);
  assert.throws(() => parseTrilinesAssistInput(body({ lines: ["", ""] })));
  assert.throws(() => parseTrilinesAssistInput(body({ lines: ["あ".repeat(51), "", ""] })));
  assert.throws(() => parseTrilinesAssistInput(body({ lang: "fr" })));
  assert.throws(() => parseTrilinesAssistInput(body({ to: "2026-11-02T00:00:00.000Z" })));
  assert.throws(() => parseTrilinesAssistInput(body({ to: "2026-11-05T03:00:00.000Z" })));
});

test("空いている行だけを埋める", () => {
  assert.deepEqual(emptyLineIndexes(["", "a", " "]), [0, 2]);
  assert.deepEqual(fillTrilines(["", "猫をなでた", ""], ["朝ごはん", "- 「早く寝た」", "余り"]), [
    "朝ごはん",
    "猫をなでた",
    "早く寝た",
  ]);
  assert.deepEqual(fillTrilines(["", "", ""], ["一つだけ"]), ["一つだけ", "", ""]);
});

test("長すぎる行は50字で切る", () => {
  assert.equal(normalizeTrilinesLine("あ".repeat(60))?.length, 50);
  assert.equal(normalizeTrilinesLine("  "), undefined);
  assert.equal(normalizeTrilinesLine(3), undefined);
});

test("プロンプトは必要な行数と既存の行を伝え、投稿を末尾に置く", () => {
  const prompt = trilinesAssistPrompt(parseTrilinesAssistInput(body()), ["カレーを作った"]);
  assert.match(prompt, /2個選び/);
  assert.match(prompt, /- 猫をなでた/);
  assert.ok(prompt.trimEnd().endsWith("- カレーを作った"));
  const en = trilinesAssistPrompt(parseTrilinesAssistInput(body({ lang: "en" })), ["Made curry"]);
  assert.match(en, /exactly 2 items/);
  assert.ok(en.trimEnd().endsWith("- Made curry"));
});

test("Ollama へ num_ctx を送らず、num_predict と temperature を送る", async () => {
  let sent: any;
  const lines = await requestTrilinesAssist("prompt", {
    model: "test-model",
    reportCall: () => {},
    fetcher: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ message: { content: '{"lines":["カレーを作った"]}' } }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(lines, ["カレーを作った"]);
  assert.equal(sent.think, false);
  assert.equal(typeof sent.options.num_predict, "number");
  assert.ok(sent.options.temperature > 0);
  assert.equal("num_ctx" in sent.options, false);
  assert.equal(sent.format.type, "object");
});

test("壊れた出力は upstream エラーにする", async () => {
  await assert.rejects(
    requestTrilinesAssist("prompt", {
      reportCall: () => {},
      fetcher: async () =>
        new Response(JSON.stringify({ message: { content: "not json" } }), { status: 200 }),
    }),
    /invalid_output/,
  );
});

test("その日の投稿がなければ生成せず noPosts を返す", async () => {
  let requested = false;
  const result = await generateTrilinesAssist("did:plc:a", body(), {
    loadPosts: async () => [],
    request: async () => {
      requested = true;
      return [];
    },
  });
  assert.deepEqual(result, { lines: ["", "猫をなでた", ""], reason: "noPosts" });
  assert.equal(requested, false);
});

test("全部埋まっていれば何もしない", async () => {
  const result = await generateTrilinesAssist("did:plc:b", body({ lines: ["a", "b", "c"] }), {
    loadPosts: async () => {
      throw new Error("should not load");
    },
  });
  assert.deepEqual(result, { lines: ["a", "b", "c"] });
});

test("生成した行を空いている行へ入れる", async () => {
  const result = await generateTrilinesAssist("did:plc:c", body(), {
    loadPosts: async () => ["カレーを作った", "早く寝た"],
    request: async () => ["カレーを作った", "早く寝た"],
  });
  assert.deepEqual(result.lines, ["カレーを作った", "猫をなでた", "早く寝た"]);
});
