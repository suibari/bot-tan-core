import assert from "node:assert/strict";
import test from "node:test";
import { ensureRadioAddress, generateNagiRadioComment, generateNagiRadioComments } from "../src/ai/generateNagiRadioComment.js";
import { selectNagiRadioCandidate } from "../src/ai/nagiRadioCandidate.js";
import { radioObservances } from "../src/ai/nagiRadioOpening.js";
import { getWhatDayForCalendarDate } from "@bsky-affirmative-bot/shared-configs";

const songs = [
  { title: "First Song", artist: "First Artist", videoId: "aaaaaaaaaaa", videoTitle: "First Song", songKey: "first" },
  { title: "Second Song", artist: "Second Artist", videoId: "bbbbbbbbbbb", videoTitle: "Second Song", songKey: "second" },
];

test("両言語を1回で生成し、片方が欠けた場合だけ再試行する", async () => {
  let calls = 0;
  const result = await generateNagiRadioComments({
    did: "did:plc:test", name: "Suibari", slotKey: "2026-09-24-08",
    posts: ["ラジオを作っている"], memory: [], hasPrivatePost: false,
    song: songs[0], fact: null,
  }, { chat: async (_route, _messages, options) => {
    calls++;
    assert.deepEqual(options?.format && (options.format as { required: string[] }).required, ["commentJa", "commentEn"]);
    return JSON.stringify(calls === 1 ? { commentJa: "一緒に聴こう。" }
      : { commentJa: "一緒に聴こう。", commentEn: "Let's listen together." });
  } });
  assert.equal(calls, 2);
  // 挨拶や記念日が生成されなくても受け入れ、定型のOpeningは付けない。
  assert.equal(result.commentJa, "Suibari、一緒に聴こう。");
  assert.equal(result.commentEn, "Suibari, Let's listen together.");
});

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
      return JSON.stringify({ commentJa: "First ArtistのFirst Songを聴こう。",
        commentEn: "Let's hear First Song by First Artist." });
    } });
    assert.equal(calls, 1);
    assert.ok(comment.includes(songs[0].title));
    assert.ok(comment.includes(songs[0].artist));
    assert.doesNotMatch(comment, /主題歌|制作|producer|soundtrack/i);
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
    return calls === 1 ? "invalid json" : JSON.stringify({ commentJa: "前に話した街の写真を思い出したよ。", commentEn: "I remembered your city photos." });
  } });
  assert.equal(calls, 2);
  assert.match(comment, /^すいばり、前に話した街の写真/);
  await assert.rejects(generateNagiRadioComment(input, { chat: async () =>
    JSON.stringify({ comment: "" }) }), /five attempts/);
});

test("朝の枠だけ、年に応じた記念日を生成材料に含める", () => {
  const observances = radioObservances("2026-09-21-08");
  assert.equal(observances.length, 1);
  assert.ok(getWhatDayForCalendarDate(2026, 9, 21).includes(observances[0]));
  assert.deepEqual(radioObservances("2026-09-21-08"), observances);
  assert.deepEqual(radioObservances("2026-09-21-14"), []);
  assert.deepEqual(radioObservances("2026-09-21-20"), []);
});

test("DJ本文で本人を一度は呼びかけ、既存の呼びかけは重ねない", () => {
  assert.equal(ensureRadioAddress("今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばり、今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばりの投稿から選んだよ。", "すいばり", "日本語"), "すいばり、すいばりの投稿から選んだよ。");
  assert.equal(ensureRadioAddress("Let's listen.", "Suibari", "English"), "Suibari, Let's listen.");
  assert.equal(ensureRadioAddress("Suibari, let's listen.", "Suibari", "English"), "Suibari, let's listen.");
  assert.equal(ensureRadioAddress("今日はこの曲を。", null, "日本語"), "今日はこの曲を。");
});
