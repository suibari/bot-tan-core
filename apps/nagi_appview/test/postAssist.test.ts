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
  postAssistWhatDay,
  recentPostAssistMessages,
  requestPostAssist,
  selectPostAssistTopic,
  spokenDate,
} = await import("../src/services/postAssist.js");

const reportCall = () => {};
const emptyMaterials = {
  anniversaries: [],
  recentDiaries: [],
  relatedPosts: [],
  interests: [],
  whatDay: [],
  news: [],
};
const materials = {
  anniversaries: [
    { ago: "year" as const, date: "2025-09-15", title: "海の日", excerpt: "海へ行った" },
  ],
  recentDiaries: [{ date: "2026-09-13", title: "本の日", excerpt: "読書をした" }],
  relatedPosts: [{ date: "2026-09-01", excerpt: "ギターの弦を替えた" }],
  interests: ["登山"],
  whatDay: ["ひじきの日"],
  news: [{ uri: "at://news/1", title: "保護犬が図書館の人気者に", comment: "ほっこり！", genre: "動物" }],
};
const emptyInput = { text: "", lang: "ja" as const, today: "2026-09-15", previous: [] as string[] };
const draftInput = { ...emptyInput, text: "久しぶりにギターを" };
/** 常に先頭を選ぶ乱数。種類の並びは定義順（未使用同士は同点）になる。 */
const first = () => 0;

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

test("reads today's observances from the shared calendar for the user's local date", () => {
  const names = postAssistWhatDay("2026-01-01");
  assert.ok(names.includes("元日"));
  assert.equal(new Set(names).size, names.length);
});

test("places the draft at the very end, after the topic and what was already said", () => {
  const topic = selectPostAssistTopic(draftInput, materials, [], first);
  assert.equal(topic.kind, "relatedPost");
  const prompt = postAssistPrompt(draftInput, topic, ["前のひとこと"]);
  assert.ok(prompt.endsWith("# ユーザーの書きかけの本文\n久しぶりにギターを"));
  for (const material of ["ギターの弦を替えた", "前のひとこと"])
    assert.ok(prompt.indexOf(material) < prompt.lastIndexOf("久しぶりにギターを"), material);
  assert.match(prompt, /敬語/);
  // ISO 形式を復唱させないよう、材料の日付は話し言葉で渡す。
  assert.match(prompt, /今日の日付: 2026年9月15日/);
  assert.match(prompt, /- 9月1日: ギターの弦を替えた/);
  assert.equal(prompt.includes("2026-09-01"), false);
  // 選んだ話題以外の材料は載せない（並べると日記の話ばかりになる）。
  for (const other of ["海の日", "本の日", "登山", "ひじきの日", "保護犬"])
    assert.equal(prompt.includes(other), false, other);
});

test("rotates to a topic kind that was not used recently", () => {
  const diary = selectPostAssistTopic(emptyInput, materials, [], first);
  assert.equal(diary.kind, "diary");
  assert.equal(diary.key, "diary:2025-09-15");

  const history = [{ kind: "diary" as const, key: diary.key, at: 1 }];
  const next = selectPostAssistTopic(emptyInput, materials, history, first);
  assert.equal(next.kind, "whatDay");

  const later = selectPostAssistTopic(
    emptyInput,
    materials,
    [...history, { kind: "whatDay", key: "whatDay:ひじきの日", at: 2 }, { kind: "interest", key: "interest:登山", at: 3 }],
    first,
  );
  assert.equal(later.kind, "news");
  // 全種類を使ったら、いちばん前に使った種類へ戻り、まだ出していない日記を選ぶ。
  const wrapped = selectPostAssistTopic(
    emptyInput,
    materials,
    [
      ...history,
      { kind: "whatDay", key: "whatDay:ひじきの日", at: 2 },
      { kind: "interest", key: "interest:登山", at: 3 },
      { kind: "news", key: "news:at://news/1", at: 4 },
    ],
    first,
  );
  assert.equal(wrapped.kind, "diary");
  assert.equal(wrapped.key, "diary:2026-09-13");
});

test("never picks a topic that is still in the history, and falls back to a plain question", () => {
  const used = [
    { kind: "diary" as const, key: "diary:2025-09-15", at: 1 },
    { kind: "diary" as const, key: "diary:2026-09-13", at: 2 },
    { kind: "whatDay" as const, key: "whatDay:ひじきの日", at: 3 },
    { kind: "interest" as const, key: "interest:登山", at: 4 },
    { kind: "news" as const, key: "news:at://news/1", at: 5 },
  ];
  assert.deepEqual(selectPostAssistTopic(emptyInput, materials, used, first), { kind: "question", key: "question" });
  assert.deepEqual(selectPostAssistTopic(emptyInput, emptyMaterials, [], first), { kind: "question", key: "question" });
  // 書きかけがあるときは、問いかけも回す話題の1つ。
  const drafted = selectPostAssistTopic(
    draftInput,
    materials,
    [{ kind: "relatedPost", key: "post:2026-09-01:ギターの弦を替えた", at: 1 }],
    first,
  );
  assert.equal(drafted.kind, "question");
});

test("breaks ties between unused kinds with the random source", () => {
  // 最初の4つは種類（diary, whatDay, interest, news）ごとの同点崩し、最後は候補の添字。
  const sequence = (...values: number[]) => () => values.shift() ?? 0;
  assert.equal(selectPostAssistTopic(emptyInput, materials, [], sequence(0.9, 0.1, 0.5, 0.7, 0)).kind, "whatDay");
  assert.equal(selectPostAssistTopic(emptyInput, materials, [], sequence(0.9, 0.8, 0.2, 0.7, 0)).kind, "interest");
  assert.equal(selectPostAssistTopic(emptyInput, materials, [], sequence(0.9, 0.8, 0.5, 0.1, 0)).kind, "news");
  // 同じ種類の中の候補もランダムに選ぶ。
  assert.equal(selectPostAssistTopic(emptyInput, materials, [], sequence(0, 0.5, 0.5, 0.5, 0.99)).key, "diary:2026-09-13");
});

test("describes today's observance, interests, and news with their own guidance", () => {
  const whatDay = postAssistPrompt(emptyInput, { kind: "whatDay", key: "whatDay:ひじきの日", name: "ひじきの日" });
  assert.match(whatDay, /## 今回の話題\n今日は何の日か。[^\n]*\n- 今日は「ひじきの日」/);
  const interest = postAssistPrompt(emptyInput, { kind: "interest", key: "interest:登山", keyword: "登山" });
  assert.match(interest, /興味を持っているテーマ[^\n]*\n- 登山/);
  const news = postAssistPrompt(emptyInput, selectPostAssistTopic(emptyInput, { ...emptyMaterials, news: materials.news }, [], first));
  assert.match(news, /- 見出し: 保護犬が図書館の人気者に\n- botたんの紹介コメント: ほっこり！\n- 本人の関心ジャンル: 動物/);
  const diary = postAssistPrompt(emptyInput, selectPostAssistTopic(emptyInput, materials, [], first));
  assert.match(diary, /- 2025年9月15日（1年前） 「海の日」: 海へ行った/);
  const en = postAssistPrompt({ ...emptyInput, lang: "en" }, { kind: "whatDay", key: "whatDay:ひじきの日", name: "ひじきの日" });
  assert.match(en, /## Topic for this time\n[^\n]*natural English\.\n- Today: ひじきの日/);
});

test("merges the server history with the client's previous lines without duplicates", () => {
  assert.deepEqual(
    recentPostAssistMessages(["B", "C"], [{ message: "A" }, { message: "B" }]),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    recentPostAssistMessages(["6", "7"], ["1", "2", "3", "4", "5"].map((message) => ({ message }))),
    ["3", "4", "5", "6", "7"],
  );
  const prompt = postAssistPrompt(emptyInput, { kind: "question", key: "question" }, ["A", "B"]);
  assert.match(prompt, /## さっき言ったこと\n- A\n- B\n/);
});

test("speaks dates in the user's language and adds the year only when it differs", () => {
  assert.equal(spokenDate("2026-09-01", "ja", "2026-09-15"), "9月1日");
  assert.equal(spokenDate("2025-12-31", "ja", "2026-09-15"), "2025年12月31日");
  assert.equal(spokenDate("2026-09-01", "en", "2026-09-15"), "September 1");
  assert.equal(spokenDate("2025-12-31", "en", "2026-09-15"), "December 31, 2025");
});

test("tells the model when nothing is written yet and when there is no material", () => {
  const question = { kind: "question" as const, key: "question" as const };
  const ja = postAssistPrompt({ ...emptyInput, text: "  " }, question);
  assert.ok(ja.endsWith("（まだ何も書いていない）"));
  assert.match(ja, /材料は無し。今の気持ち/);
  const en = postAssistPrompt({ ...emptyInput, lang: "en" }, question);
  assert.ok(en.endsWith("(nothing written yet)"));
  assert.match(en, /Bot-tan/);
});

test("keeps the latest part of a long draft", () => {
  const text = `${"古".repeat(2000)}${"新".repeat(1000)}`;
  const prompt = postAssistPrompt({ ...emptyInput, text }, { kind: "question", key: "question" });
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
