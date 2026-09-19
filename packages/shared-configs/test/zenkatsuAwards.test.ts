import assert from "node:assert/strict";
import test from "node:test";
import {
  decideDeterministicAwards,
  shortlistForBotan,
  type ZenkatsuAwardCandidate,
} from "../src/zenkatsuAwards.js";

const c = (over: Partial<ZenkatsuAwardCandidate>): ZenkatsuAwardCandidate => ({
  submissionUri: `at://x/${over.did ?? "a"}`,
  did: "did:plc:a",
  score: 100,
  cardCount: 3,
  tailwindCount: 0,
  debutCount: 0,
  rarities: ["N", "N", "N"],
  newComboCount: 0,
  indexedAt: 1000,
  ...over,
});

test("各賞の受賞者は1人（条件を満たす全員には配らない）", () => {
  const awards = decideDeterministicAwards([
    c({ did: "did:plc:a", cardCount: 1, score: 200 }),
    c({ did: "did:plc:b", cardCount: 1, score: 150 }),
    c({ did: "did:plc:c", cardCount: 1, score: 120 }),
  ]);
  const solo = awards.filter((a) => a.kind === "solo");
  assert.equal(solo.length, 1);
  assert.equal(solo[0].did, "did:plc:a");
});

test("賞の切り口が分かれていれば、別々の人に当たる", () => {
  // 1人勝ちにならないことが「毎日誰かしらに何か当たる」の実体。
  const awards = decideDeterministicAwards([
    c({ did: "did:plc:solo", cardCount: 1, score: 300 }),
    c({ did: "did:plc:rare", rarities: ["AAR", "N", "N"] }),
    c({ did: "did:plc:debut", debutCount: 3 }),
    c({ did: "did:plc:wind", cardCount: 2, tailwindCount: 2, score: 250 }),
    c({ did: "did:plc:combo", newComboCount: 1 }),
  ]);
  assert.deepEqual(
    awards.map((a) => `${a.kind}:${a.did}`).sort(),
    [
      "adventure:did:plc:rare",
      "combo:did:plc:combo",
      "debut:did:plc:debut",
      "solo:did:plc:solo",
      "tailwind:did:plc:wind",
    ],
  );
});

test("条件を満たす人が居ない賞は出さない", () => {
  const awards = decideDeterministicAwards([c({})]);
  // N3枚・追い風0・初登板0・3枚・コンボ無し → どの賞にも当たらない。
  assert.deepEqual(awards, []);
});

test("N しか出していない日は「今日いちばんの冒険」が出ない", () => {
  const awards = decideDeterministicAwards([
    c({ rarities: ["N", "R"] }),
    c({ did: "did:plc:b", rarities: ["R"] }),
  ]);
  assert.equal(awards.some((a) => a.kind === "adventure"), false);
});

test("1枚だけの提出は追い風満帆の対象外（一枚斬りと二重取りしない）", () => {
  const awards = decideDeterministicAwards([
    c({ did: "did:plc:one", cardCount: 1, tailwindCount: 1 }),
  ]);
  assert.equal(awards.some((a) => a.kind === "tailwind"), false);
  assert.ok(awards.some((a) => a.kind === "solo"));
});

test("同点は先に出したほうが勝つ（あとから結果が動かない）", () => {
  const awards = decideDeterministicAwards([
    c({ did: "did:plc:late", cardCount: 1, score: 200, indexedAt: 5000 }),
    c({ did: "did:plc:early", cardCount: 1, score: 200, indexedAt: 1000 }),
  ]);
  assert.equal(awards.find((a) => a.kind === "solo")?.did, "did:plc:early");
});

test("botたん賞の候補は隠し得点の上位だけに絞る", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    c({ did: `did:plc:${i}`, score: i * 10 }),
  );
  const short = shortlistForBotan(many);
  assert.equal(short.length, 5);
  // いちばん高い score から順に並ぶ。
  assert.deepEqual(short.map((s) => s.score), [110, 100, 90, 80, 70]);
});
