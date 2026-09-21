import assert from "node:assert/strict";
import test from "node:test";
import {
  candidatesForBottan,
  immediateZenkatsuAwards,
  shortlistForBottan,
  type ZenkatsuBotanCandidate,
} from "../src/zenkatsuAwards.js";

const awards = (
  rarities: ("N" | "R" | "SR" | "UR" | "AAR")[],
  tailwindCount = 0,
  newComboCount = 0,
) => immediateZenkatsuAwards({ rarities, tailwindCount, newComboCount });

test("SR以上を出した本人へ決意のドラ切り賞を贈る", () => {
  assert.deepEqual(awards(["N", "SR"]), ["adventure"]);
  assert.deepEqual(awards(["N", "R"]), []);
});

test("1枚で答えた本人へ単騎待ち賞を贈る", () => {
  assert.deepEqual(awards(["N"]), ["solo"]);
  assert.deepEqual(awards(["N", "N"]), []);
});

test("三色同順は3枚すべてがおすすめ属性の場合だけ贈る", () => {
  assert.deepEqual(awards(["N", "N", "N"], 3), ["tailwind"]);
  assert.deepEqual(awards(["N", "N"], 2), []);
  assert.deepEqual(awards(["N", "N", "N"], 2), []);
});

test("コンボ初発見は件数にかかわらず本人へ1件贈る", () => {
  assert.deepEqual(awards(["N", "N"], 0, 2), ["combo"]);
  assert.deepEqual(awards(["N", "N"], 0, 0), []);
});

test("1回の提出で複数の賞を受け取れる", () => {
  assert.deepEqual(awards(["SR"], 0, 1), ["adventure", "solo", "combo"]);
});

test("部長賞は翌朝の候補から1人を選ぶため、候補を5人までに絞る", () => {
  const candidates: ZenkatsuBotanCandidate[] = Array.from({ length: 12 }, (_, i) => ({
    submissionUri: `at://did:plc:${i}/submission`,
    did: `did:plc:${i}`,
    score: i * 10,
    indexedAt: i,
  }));
  assert.deepEqual(shortlistForBottan(candidates).map((candidate) => candidate.score), [110, 100, 90, 80, 70]);
});

test("前日の部長は他の提出者がいれば、得点にかかわらず候補から外す", () => {
  const candidates: ZenkatsuBotanCandidate[] = [
    { submissionUri: "at://previous", did: "did:plc:previous", score: 200, indexedAt: 1 },
    { submissionUri: "at://other", did: "did:plc:other", score: 100, indexedAt: 2 },
  ];

  assert.deepEqual(
    candidatesForBottan(candidates, "did:plc:previous").map(
      (candidate) => candidate.did,
    ),
    ["did:plc:other"],
  );
});

test("前日の部長しか提出していない日は、再選の候補に残す", () => {
  const candidates: ZenkatsuBotanCandidate[] = [
    { submissionUri: "at://previous", did: "did:plc:previous", score: 100, indexedAt: 1 },
  ];

  assert.deepEqual(
    candidatesForBottan(candidates, "did:plc:previous"),
    candidates,
  );
});
