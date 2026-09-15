import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const {
  excerpt,
  normalizePostAssistMessage,
  parsePostAssistInput,
  postAssistDates,
  postAssistPrompt,
  requestPostAssist,
  spokenDate,
  startingTopic,
} = await import("../src/services/postAssist.js");

const reportCall = () => {};
const emptyMaterials = { anniversaries: [], recentDiaries: [], relatedPosts: [], interests: [] };
const materials = {
  anniversaries: [
    { ago: "year" as const, date: "2025-09-15", title: "海の日", excerpt: "海へ行った" },
  ],
  recentDiaries: [{ date: "2026-09-13", title: "本の日", excerpt: "読書をした" }],
  relatedPosts: [{ date: "2026-09-01", excerpt: "ギターの弦を替えた" }],
  interests: ["登山"],
};

const assertInvalid = (body: unknown) =>
  assert.throws(() => parsePostAssistInput(body), { status: 400, error: "invalid_request" });

test("accepts a draft with its language and local date, and rejects malformed input", () => {
  assert.deepEqual(parsePostAssistInput({ text: "", lang: "ja", today: "2026-09-15" }), {
    text: "",
    lang: "ja",
    today: "2026-09-15",
    previous: [],
  });
  assertInvalid({ lang: "ja", today: "2026-09-15" });
  assertInvalid({ text: "あ", lang: "fr", today: "2026-09-15" });
  assertInvalid({ text: "あ", lang: "ja", today: "2026-02-30" });
  assertInvalid({ text: "あ".repeat(3001), lang: "ja", today: "2026-09-15" });
  assertInvalid({ text: "", lang: "ja", today: "2026-09-15", previous: ["a", "b", "c", "d", "e", "f"] });
  assertInvalid({ text: "", lang: "ja", today: "2026-09-15", previous: [1] });
});

test("looks for diaries on the same calendar day and skips days that do not exist", () => {
  assert.deepEqual(postAssistDates("2026-09-15"), {
    yearAgo: "2025-09-15",
    monthAgo: "2026-08-15",
    recentFrom: "2026-09-08",
  });
  assert.equal(postAssistDates("2026-03-31").monthAgo, undefined);
  assert.equal(postAssistDates("2028-02-29").yearAgo, undefined);
});

test("places the draft at the very end, after every instruction and material", () => {
  const prompt = postAssistPrompt(
    { text: "久しぶりにギターを", lang: "ja", today: "2026-09-15", previous: ["前のひとこと"] },
    materials,
  );
  assert.ok(prompt.endsWith("# ユーザーの書きかけの本文\n久しぶりにギターを"));
  for (const material of ["海の日", "本の日", "ギターの弦を替えた", "登山", "前のひとこと"])
    assert.ok(prompt.indexOf(material) < prompt.lastIndexOf("久しぶりにギターを"), material);
  assert.match(prompt, /敬語/);
  // ISO 形式を復唱させないよう、材料の日付は話し言葉で渡す。
  assert.match(prompt, /今日の日付: 2026年9月15日/);
  assert.match(prompt, /- 9月13日 「本の日」/);
  assert.match(prompt, /- 2025年9月15日（1年前）「海の日」/);
  assert.equal(prompt.includes("2026-09-13"), false);
  // 書きかけがあるときは、取り上げる出来事をサーバー側で決めない。
  assert.equal(prompt.includes("## 今回取り上げる出来事"), false);
});

test("hands one diary event to bring up while the draft is empty, rotating as it speaks", () => {
  const input = { text: "", lang: "ja" as const, today: "2026-09-15", previous: [] as string[] };
  assert.equal(startingTopic(input, materials)?.title, "海の日");
  assert.equal(startingTopic({ ...input, previous: ["a"] }, materials)?.title, "本の日");
  assert.equal(startingTopic({ ...input, previous: ["a", "b"] }, materials)?.title, "海の日");
  assert.equal(startingTopic(input, emptyMaterials), undefined);
  assert.match(postAssistPrompt(input, materials), /## 今回取り上げる出来事\n- 2025年9月15日 「海の日」: 海へ行った/);
  assert.match(
    postAssistPrompt({ ...input, lang: "en" }, materials),
    /## Event to bring up\n- September 15, 2025 "海の日": 海へ行った/,
  );
});

test("speaks dates in the user's language and adds the year only when it differs", () => {
  assert.equal(spokenDate("2026-09-01", "ja", "2026-09-15"), "9月1日");
  assert.equal(spokenDate("2025-12-31", "ja", "2026-09-15"), "2025年12月31日");
  assert.equal(spokenDate("2026-09-01", "en", "2026-09-15"), "September 1");
  assert.equal(spokenDate("2025-12-31", "en", "2026-09-15"), "December 31, 2025");
});

test("tells the model when nothing is written yet and when there is no material", () => {
  const ja = postAssistPrompt({ text: "  ", lang: "ja", today: "2026-09-15", previous: [] }, emptyMaterials);
  assert.ok(ja.endsWith("（まだ何も書いていない）"));
  assert.match(ja, /（材料なし）/);
  const en = postAssistPrompt({ text: "", lang: "en", today: "2026-09-15", previous: [] }, materials);
  assert.ok(en.endsWith("(nothing written yet)"));
  assert.match(en, /Bot-tan/);
});

test("keeps the latest part of a long draft", () => {
  const text = `${"古".repeat(2000)}${"新".repeat(1000)}`;
  const prompt = postAssistPrompt({ text, lang: "ja", today: "2026-09-15", previous: [] }, emptyMaterials);
  assert.ok(prompt.endsWith(`…${"古".repeat(500)}${"新".repeat(1000)}`));
});

test("cleans labels, quotes, and line breaks from the generated line", () => {
  assert.equal(normalizePostAssistMessage("botたん：「ギター、久しぶりなんだね！\nどんな曲を弾くの？」"), "ギター、久しぶりなんだね！ どんな曲を弾くの？");
  assert.equal(normalizePostAssistMessage("<think>hmm</think>  "), undefined);
  assert.equal([...normalizePostAssistMessage("あ".repeat(500))!].length, 200);
  assert.equal(excerpt(" a\n b ", 10), "a b");
  assert.equal(excerpt("あいうえお", 3), "あいう…");
});

test("sends num_predict and temperature to the native chat API, never num_ctx", async () => {
  let body: any;
  const message = await requestPostAssist("prompt", {
    model: "test-model",
    reportCall,
    fetcher: async (url, init) => {
      assert.match(String(url), /\/api\/chat$/);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { content: "「どんな曲？」" } }), { status: 200 });
    },
  });
  assert.equal(message, "どんな曲？");
  assert.equal(body.model, "test-model");
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(typeof body.options.num_predict, "number");
  assert.equal(typeof body.options.temperature, "number");
  assert.ok(body.options.temperature > 0);
  assert.equal("num_ctx" in body.options, false);
});

test("reports an unavailable upstream instead of an empty line", async () => {
  await assert.rejects(
    requestPostAssist("prompt", {
      reportCall,
      fetcher: async () => new Response(JSON.stringify({ message: { content: "  " } }), { status: 200 }),
    }),
    { status: 503, error: "upstream_unavailable" },
  );
  await assert.rejects(
    requestPostAssist("prompt", { reportCall, fetcher: async () => new Response("", { status: 500 }) }),
    { status: 503 },
  );
  await assert.rejects(
    requestPostAssist("x".repeat(1_000_000), { reportCall, fetcher: async () => assert.fail("must not call") }),
    { status: 503 },
  );
});
