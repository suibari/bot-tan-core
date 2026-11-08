import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adventDueDays,
  adventOpenedDay,
  adventPublishAt,
  joinedInAdventMonth,
  rankAdventCandidates,
  type AdventCandidateUser,
} from "../src/adventCalendar.js";

test("公開は JST 0:00、選出はその1時間前", () => {
  assert.equal(adventPublishAt(2026, 1).toISOString(), "2026-11-30T15:00:00.000Z");
  assert.deepEqual(adventDueDays(2026, new Date("2026-11-30T13:59:59Z")), []);
  assert.deepEqual(adventDueDays(2026, new Date("2026-11-30T14:00:00Z")), [1]);
  assert.equal(adventOpenedDay(2026, new Date("2026-11-30T14:30:00Z")), 0);
  assert.equal(adventOpenedDay(2026, new Date("2026-11-30T15:00:00Z")), 1);
  assert.equal(adventOpenedDay(2026, new Date("2026-12-31T00:00:00Z")), 25);
});

test("12月の始めた人は JST で判定する", () => {
  assert.equal(joinedInAdventMonth(2026, new Date("2026-11-30T15:00:00Z")), true);
  assert.equal(joinedInAdventMonth(2026, new Date("2026-11-30T14:59:59Z")), false);
  assert.equal(joinedInAdventMonth(2026, new Date("2026-12-31T15:00:00Z")), false);
});

const post = (did: string, valence: number, createdAt = 0) => ({
  uri: `at://${did}/p/${valence}-${createdAt}`,
  cid: "c",
  did,
  text: "t",
  valence,
  createdAt,
});
const user = (did: string, extra: Partial<AdventCandidateUser> = {}): AdventCandidateUser => ({
  did,
  picked: false,
  joinedThisMonth: false,
  posts: [post(did, 3)],
  ...extra,
});

test("未選出 > 12月に始めた人 > くじ の順。選ばれた人は最後", () => {
  const ranked = rankAdventCandidates(
    [
      user("did:a", { picked: true, joinedThisMonth: true }),
      user("did:b"),
      user("did:c", { joinedThisMonth: true }),
      user("did:d", { posts: [] }),
    ],
    "2026-12-01",
  );
  assert.deepEqual(
    ranked.map((u) => u.did),
    ["did:c", "did:b", "did:a"],
  );
});

test("くじは同じ日なら同じ並び、日が変わると変わりうる", () => {
  const users = Array.from({ length: 20 }, (_, i) => user(`did:u${i}`));
  const a = rankAdventCandidates(users, "2026-12-01").map((u) => u.did);
  assert.deepEqual(rankAdventCandidates(users, "2026-12-01").map((u) => u.did), a);
  assert.notDeepEqual(rankAdventCandidates(users, "2026-12-02").map((u) => u.did), a);
});

test("1人の候補は気分の高い順・新しい順に3件まで", () => {
  const [ranked] = rankAdventCandidates(
    [user("did:a", { posts: [post("did:a", 3, 1), post("did:a", 5, 0), post("did:a", 3, 2), post("did:a", 4, 0)] })],
    "s",
  );
  assert.deepEqual(
    ranked.posts.map((p) => [p.valence, p.createdAt]),
    [[5, 0], [4, 0], [3, 2]],
  );
});
