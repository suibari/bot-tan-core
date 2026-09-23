import assert from "node:assert/strict";
import test from "node:test";
import { ensureRadioAddress, generateNagiRadioComment } from "../src/ai/generateNagiRadioComment.js";
import { selectNagiRadioCandidate } from "../src/ai/nagiRadioCandidate.js";
import { radioGreeting, radioObservances } from "../src/ai/nagiRadioOpening.js";
import { getWhatDayForCalendarDate } from "@bsky-affirmative-bot/shared-configs";

const songs = [
  { title: "First Song", artist: "First Artist", videoId: "aaaaaaaaaaa", videoTitle: "First Song", songKey: "first" },
  { title: "Second Song", artist: "Second Artist", videoId: "bbbbbbbbbbb", videoTitle: "Second Song", songKey: "second" },
];

test("制作情報が3件とも見つからなくても最初の確認済み曲を選ぶ", async () => {
  const result = await selectNagiRadioCandidate(
    async (attempt) => songs[attempt] ?? null,
    async () => null,
  );
  assert.deepEqual(result, { song: songs[0], fact: null });
});

test("検索サービスが失敗しても確認済み曲を失わない", async () => {
  const result = await selectNagiRadioCandidate(
    async (attempt) => attempt === 0 ? songs[0] : null,
    async () => { throw new Error("search unavailable"); },
  );
  assert.deepEqual(result, { song: songs[0], fact: null });
});

test("後続候補の検索が失敗しても最初の曲を届ける", async () => {
  const result = await selectNagiRadioCandidate(
    async (attempt) => {
      if (attempt === 0) return songs[0];
      throw new Error("music API unavailable");
    },
    async () => null,
  );
  assert.deepEqual(result, { song: songs[0], fact: null });
});

test("制作情報がある後続候補を優先する", async () => {
  const fact = { fact: "A verified film theme.", sourceUrl: "https://example.com/song" };
  const result = await selectNagiRadioCandidate(
    async (attempt) => songs[attempt] ?? null,
    async (song) => song.songKey === "second" ? fact : null,
  );
  assert.deepEqual(result, { song: songs[1], fact });
});

test("候補が空や検索エラーでも全体を引き直す", async () => {
  const calls: number[] = [];
  const result = await selectNagiRadioCandidate(
    async (attempt) => {
      calls.push(attempt);
      if (attempt === 0) return null;
      if (attempt === 1) throw new Error("temporary API failure");
      return songs[0];
    },
    async () => null,
  );
  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(result, { song: songs[0], fact: null });
});

test("出典がなくてもAIで日本語と英語の紹介文を作る", async () => {
  for (const language of ["日本語", "English"] as const) {
    let calls = 0;
    const comment = await generateNagiRadioComment({
      did: "did:plc:test", name: "Suibari", slotKey: "2026-09-23-20",
      posts: ["A recent post"], memory: [], hasPrivatePost: false,
      language, song: songs[0], fact: null,
    }, { chat: async (_route, messages) => {
      calls++;
      assert.match(messages[0].content, /verifiedFact/);
      return JSON.stringify({ comment: language === "日本語"
        ? "First ArtistのFirst Songを聴こう。"
        : "Let's hear First Song by First Artist." });
    } });
    assert.equal(calls, 1);
    assert.ok(comment.includes(songs[0].title));
    assert.ok(comment.includes(songs[0].artist));
    assert.doesNotMatch(comment, /主題歌|制作|producer|soundtrack/i);
    assert.ok(comment.startsWith(language === "日本語" ? "こんばんは！" : "Good evening!"));
    assert.ok(comment.includes("Suibari,") || comment.includes("Suibari、"));
  }
});

test("AI応答が一時的に不正でも再試行し、失敗し続けたら公開しない", async () => {
  const input = {
    did: "did:plc:test", name: "すいばり", slotKey: "2026-09-23-20",
    posts: [], memory: ["街の写真を見て出かけたい"], hasPrivatePost: false,
    language: "日本語" as const, song: songs[0], fact: null,
  };
  let calls = 0;
  const comment = await generateNagiRadioComment(input, { chat: async () => {
    calls++;
    return calls === 1 ? "invalid json" : JSON.stringify({ comment: "前に話した街の写真を思い出したよ。" });
  } });
  assert.equal(calls, 2);
  assert.match(comment, /^こんばんは！すいばり、前に話した街の写真/);
  await assert.rejects(generateNagiRadioComment(input, { chat: async () =>
    JSON.stringify({ comment: "" }) }), /five attempts/);
});

test("朝の枠だけ、年に応じた記念日を挨拶に含める", () => {
  const observances = radioObservances("2026-09-21-08");
  assert.equal(observances.length, 1);
  assert.ok(getWhatDayForCalendarDate(2026, 9, 21).includes(observances[0]));
  assert.deepEqual(radioObservances("2026-09-21-08"), observances);
  assert.equal(radioGreeting("2026-09-21-08", "日本語"), `おはよう！今日は${observances[0]}だね。`);
  assert.equal(radioGreeting("2026-09-21-14", "日本語"), "こんにちは！");
  assert.equal(radioGreeting("2026-09-21-20", "日本語"), "こんばんは！");
  assert.equal(radioGreeting("2026-09-21-08", "English"), "Good morning!");
});

test("DJ本文で本人を一度は呼びかけ、既存の呼びかけは重ねない", () => {
  assert.equal(ensureRadioAddress("今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばり、今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばりの投稿から選んだよ。", "すいばり", "日本語"), "すいばり、すいばりの投稿から選んだよ。");
  assert.equal(ensureRadioAddress("Let's listen.", "Suibari", "English"), "Suibari, Let's listen.");
  assert.equal(ensureRadioAddress("Suibari, let's listen.", "Suibari", "English"), "Suibari, let's listen.");
  assert.equal(ensureRadioAddress("今日はこの曲を。", null, "日本語"), "今日はこの曲を。");
});
