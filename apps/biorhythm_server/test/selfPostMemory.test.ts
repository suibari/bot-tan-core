import assert from "node:assert/strict";
import test from "node:test";
import {
  emptySelfPostMemory,
  MAX_OWN_POSTS,
  normalizeSelfPostMemory,
  recentOwnPostsFor,
  recordOwnPost,
  setTomorrowHook,
  tomorrowHookFor,
} from "../src/selfPostMemory.js";
import { buildBiorhythmBotContext } from "../src/botMemory.js";
import { buildDailyPlanPrompt } from "../src/dailyPlan.js";

const at = (iso: string) => new Date(iso);

test("24時間より古い自分の投稿は記録の時点で落とす", () => {
  let state = recordOwnPost(emptySelfPostMemory(), {
    kind: "morning",
    text: "おはよう！",
    now: at("2026-10-23T23:00:00Z"),
  });
  state = recordOwnPost(state, {
    kind: "whimsical",
    text: "図書室で星の図鑑を読んでるよ",
    now: at("2026-10-25T00:00:00Z"),
  });

  assert.deepEqual(state.posts.map((post) => post.kind), ["whimsical"]);
});

test("件数でも絞り、空の本文は記録しない", () => {
  let state = emptySelfPostMemory();
  const base = at("2026-10-24T03:00:00Z").getTime();
  for (let i = 0; i < MAX_OWN_POSTS + 3; i++) {
    state = recordOwnPost(state, { kind: "monologue", text: `ひとりごと${i}`, now: new Date(base + i * 60_000) });
  }
  state = recordOwnPost(state, { kind: "monologue", text: "  ", now: new Date(base + 99 * 60_000) });

  assert.equal(state.posts.length, MAX_OWN_POSTS);
  assert.equal(state.posts.at(-1)?.text, `ひとりごと${MAX_OWN_POSTS + 2}`);
});

test("読み出しでも24時間の窓を当てる", () => {
  const state = recordOwnPost(emptySelfPostMemory(), {
    kind: "goodnight",
    text: "おやすみ",
    now: at("2026-10-24T13:00:00Z"),
  });

  assert.equal(recentOwnPostsFor(state, at("2026-10-25T12:00:00Z")).length, 1);
  assert.equal(recentOwnPostsFor(state, at("2026-10-25T14:00:00Z")).length, 0);
});

test("明日のひとことは、おやすみを書いた bot 日の翌日だけ返す", () => {
  // JST 10/24 23:00 のおやすみ → bot 日 10/25 に載る
  const state = setTomorrowHook(emptySelfPostMemory(), {
    text: "星の図鑑の続きを読みたい",
    now: at("2026-10-24T14:00:00Z"),
  });

  assert.equal(state.tomorrowHook?.forBotDate, "2026-10-25");
  // JST 10/25 02:00 はまだ bot 日 10/24
  assert.equal(tomorrowHookFor(state, at("2026-10-24T17:00:00Z")), undefined);
  // JST 10/25 08:00
  assert.equal(tomorrowHookFor(state, at("2026-10-24T23:00:00Z")), "星の図鑑の続きを読みたい");
  // JST 10/26 08:00
  assert.equal(tomorrowHookFor(state, at("2026-10-25T23:00:00Z")), undefined);
});

test("深夜0〜3時のおやすみも、同じ bot 日の翌日へ持ち越す", () => {
  // JST 10/25 02:00 は bot 日 10/24
  const state = setTomorrowHook(emptySelfPostMemory(), {
    text: "早起きしてお散歩したい",
    now: at("2026-10-24T17:00:00Z"),
  });

  assert.equal(state.tomorrowHook?.forBotDate, "2026-10-25");
});

test("壊れた値は空として読む", () => {
  assert.deepEqual(normalizeSelfPostMemory(null), { posts: [] });
  assert.deepEqual(
    normalizeSelfPostMemory({
      posts: [{ at: "2026-10-24T00:00:00Z", kind: "unknown", text: "x" }, { kind: "morning" }],
      tomorrowHook: { text: 1 },
    }),
    { posts: [] },
  );
});

test("定期ポストの botContext に自分の投稿と明日のひとことを載せる", () => {
  const now = at("2026-10-24T23:00:00Z");
  let selfPosts = recordOwnPost(emptySelfPostMemory(), {
    kind: "goodnight",
    text: "きょうもありがとう、おやすみ",
    now: at("2026-10-24T14:00:00Z"),
  });
  selfPosts = setTomorrowHook(selfPosts, { text: "星の図鑑の続きを読みたい", now: at("2026-10-24T14:00:00Z") });

  const context = buildBiorhythmBotContext({
    mood: "全肯定たんは、起きたところです。",
    moodEn: "Bot-tan just woke up.",
    energy: 80,
    weather: "晴れ",
    history: [],
    selfPosts,
    now,
  });

  assert.equal(context.recentOwnPosts?.[0]?.kind, "goodnight");
  assert.equal(context.tomorrowHook, "星の図鑑の続きを読みたい");
});

test("selfPosts が無ければ何も足さない", () => {
  const context = buildBiorhythmBotContext({
    mood: "a",
    moodEn: "a",
    energy: 50,
    weather: "晴れ",
    history: [],
  });

  assert.equal(context.recentOwnPosts, undefined);
  assert.equal(context.tomorrowHook, undefined);
});

test("予定表のプロンプトに前夜のひとことを入れる", () => {
  const input = {
    botDate: "2026-10-25",
    isWeekend: true,
    companion: "ひとり",
    outingPlaces: ["駅ビルの水族館"],
    whatDay: [],
    eventSamples: {},
    worksSection: "",
  };

  assert.match(buildDailyPlanPrompt({ ...input, tomorrowHook: "星の図鑑の続きを読みたい" }), /「星の図鑑の続きを読みたい」/);
  assert.doesNotMatch(buildDailyPlanPrompt(input), /今日やりたいこと/);
});
