import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdventCandidateUser } from "@bsky-affirmative-bot/shared-configs";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/unused";
const { pickAdventCard, ADVENT_USERS_PER_BATCH } = await import("../src/NagiAdventFeature.js");

const user = (i: number, picked = false): AdventCandidateUser => ({
  did: `did:plc:u${i}`,
  picked,
  joinedThisMonth: false,
  posts: [
    { uri: `at://u${i}/p/1`, cid: "c", did: `did:plc:u${i}`, text: `post ${i}`, valence: 4, createdAt: Date.UTC(2026, 7, 1) },
  ],
});
const result = (pick: number, rejectedAll = pick === 0) => ({
  pick,
  rejectedAll,
  titleJa: "t",
  titleEn: "t",
  commentJa: "c",
  commentEn: "c",
});

test("モデルが 0 を返したら次の数人へ進み、見せたポストを記録する", async () => {
  const ranked = Array.from({ length: ADVENT_USERS_PER_BATCH + 2 }, (_, i) => user(i));
  const calls: string[][] = [];
  const shown = new Set<string>();
  const chosen = await pickAdventCard({
    day: 1,
    ranked,
    names: new Map([["did:plc:u7", "なな"]]),
    shown,
    picker: async (input) => {
      calls.push(input.candidates.map((c) => c.text));
      return calls.length === 1 ? result(0) : result(2);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, ADVENT_USERS_PER_BATCH);
  assert.equal(chosen?.post.did, "did:plc:u7");
  assert.equal(shown.size, ADVENT_USERS_PER_BATCH + 2);
});

test("選ばれたことのある人は未選出の人と同じ回に混ぜない", async () => {
  const ranked = [user(0), user(1, true), user(2)];
  const calls: string[][] = [];
  await pickAdventCard({
    day: 1,
    ranked,
    names: new Map(),
    picker: async (input) => {
      calls.push(input.candidates.map((c) => c.text));
      return result(0);
    },
  });
  assert.deepEqual(calls, [["post 0", "post 2"], ["post 1"]]);
});

test("12月に始めた人だけの回を先に見せる", async () => {
  const newcomer = { ...user(9), joinedThisMonth: true };
  const calls: string[][] = [];
  await pickAdventCard({
    day: 1,
    ranked: [user(0), newcomer, user(1, true)],
    names: new Map(),
    picker: async (input) => {
      calls.push(input.candidates.map((c) => c.text));
      return result(0);
    },
  });
  assert.deepEqual(calls, [["post 9"], ["post 0"], ["post 1"]]);
});

test("回ごと不採用のときだけ、その回のポストを記録する", async () => {
  const rejected: string[][] = [];
  await pickAdventCard({
    day: 1,
    ranked: [user(0), { ...user(1), joinedThisMonth: true }, user(2, true)],
    names: new Map(),
    onReject: (uris) => void rejected.push(uris),
    picker: async (input) =>
      input.candidates[0].text === "post 0" ? result(0, false) : result(0, true),
  });
  // post 0 の回は「選んだが文面が書けなかった」なので記録しない。
  assert.deepEqual(rejected, [["at://u1/p/1"], ["at://u2/p/1"]]);
});

test("候補を見せる日付は JST", async () => {
  const late = user(0);
  late.posts[0].createdAt = Date.parse("2026-08-01T16:00:00Z");
  let date = "";
  await pickAdventCard({
    day: 1,
    ranked: [late],
    names: new Map(),
    picker: async (input) => {
      date = input.candidates[0].date;
      return result(1);
    },
  });
  assert.equal(date, "2026-08-02");
});
