import assert from "node:assert/strict";
import test from "node:test";
import { generateNagiRadioComment } from "../src/ai/generateNagiRadioComment.js";
import { selectNagiRadioCandidate } from "../src/ai/nagiRadioCandidate.js";

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

test("出典がない場合も背景を創作せず、日本語と英語で紹介文を返す", async () => {
  for (const language of ["日本語", "English"] as const) {
    const comment = await generateNagiRadioComment({
      did: "did:plc:test", name: null, slotKey: "2026-09-23-20",
      posts: ["A recent post"], memory: [], hasPrivatePost: false,
      language, song: songs[0], fact: null,
    });
    assert.ok(comment.includes(songs[0].title));
    assert.ok(comment.includes(songs[0].artist));
    assert.doesNotMatch(comment, /主題歌|制作|producer|soundtrack/i);
  }
});
