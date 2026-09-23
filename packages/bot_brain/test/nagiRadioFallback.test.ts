import assert from "node:assert/strict";
import test from "node:test";
import { ensureRadioAddress, generateNagiRadioComment, safeNagiRadioComment } from "../src/ai/generateNagiRadioComment.js";
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
    assert.ok(comment.startsWith(language === "日本語" ? "こんばんは！" : "Good evening!"));
  }
});

test("新しい投稿がないときは古い記憶として紹介する", () => {
  const comment = safeNagiRadioComment(
    songs[0], null, "日本語", "2026-09-23-20", [], false,
    ["街の写真を見て出かけたい"],
  );
  assert.match(comment, /前に「街の写真を見て出かけたい」って話してくれたよね/);
  assert.doesNotMatch(comment, /最近の投稿/);
  const privateComment = safeNagiRadioComment(
    songs[0], null, "日本語", "2026-09-23-20", [], true,
    ["こっそり話した具体的な悩み"],
  );
  assert.doesNotMatch(privateComment, /具体的な悩み/);
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
  const englishComment = safeNagiRadioComment(songs[0], null, "English", "2026-09-21-08");
  assert.match(englishComment, /^Good morning! Today is /);
  assert.equal((englishComment.match(/Today is /g) ?? []).length, 1);
});

test("確認済みのオープニング情報から投稿の新しい場所へつなぐ", () => {
  const fact = { fact: "『NARUTO -ナルト- 疾風伝』のオープニングテーマ。", sourceUrl: "https://example.com/song" };
  const comment = safeNagiRadioComment(
    songs[0], fact, "日本語", "2026-09-23-20", ["新しい場所を作りたい"], false,
  );
  assert.match(comment, /NARUTO.*オープニングテーマ。オープニングは物語の始まり.*新しい場所/s);
  const privateComment = safeNagiRadioComment(
    songs[0], fact, "日本語", "2026-09-23-20", ["新しい場所を作りたい"], true,
  );
  assert.doesNotMatch(privateComment, /新しい場所/);
});

test("DJ本文で本人を一度は呼びかけ、既存の呼びかけは重ねない", () => {
  assert.equal(ensureRadioAddress("今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばり、今日はこの曲を。", "すいばり", "日本語"), "すいばり、今日はこの曲を。");
  assert.equal(ensureRadioAddress("すいばりの投稿から選んだよ。", "すいばり", "日本語"), "すいばり、すいばりの投稿から選んだよ。");
  assert.equal(ensureRadioAddress("Let's listen.", "Suibari", "English"), "Suibari, Let's listen.");
  assert.equal(ensureRadioAddress("Suibari, let's listen.", "Suibari", "English"), "Suibari, let's listen.");
  assert.equal(ensureRadioAddress("今日はこの曲を。", null, "日本語"), "今日はこの曲を。");
});

test("安全なDJコメントでも時刻の挨拶の直後に本人を呼ぶ", () => {
  const comment = safeNagiRadioComment(songs[0], null, "日本語", "2026-09-23-20", [], false, [], "すいばり");
  assert.match(comment, /^こんばんは！すいばり、/);
  const english = safeNagiRadioComment(songs[0], null, "English", "2026-09-23-20", [], false, [], "Suibari");
  assert.match(english, /^Good evening! Suibari, /);
});
