import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublishableGraphLabel,
  mergeBotMemoryGraphEdges,
  scoreBotMemoryGraphNode,
  selectBotMemoryGraphNodes,
  type BotMemoryGraphNodeRow,
} from "../src/botMemoryGraph.js";

const NOW = new Date("2026-09-05T00:00:00Z");

function nodeRow(overrides: Partial<BotMemoryGraphNodeRow> = {}): BotMemoryGraphNodeRow {
  return {
    key: "かんこれ",
    label: "艦これ",
    kind: "work",
    relation: "liked",
    occurrences: 3,
    latestAt: new Date("2026-09-01T00:00:00Z"),
    salience: 70,
    scoredCount: 2,
    ...overrides,
  };
}

test("ラベル自体が発言の断片になっていないか弾く", () => {
  assert.equal(isPublishableGraphLabel("艦これ"), true);
  assert.equal(isPublishableGraphLabel(" 散歩 "), true);
  assert.equal(isPublishableGraphLabel(""), false);
  assert.equal(isPublishableGraphLabel("   "), false);
  // ハンドル・DID・URL
  assert.equal(isPublishableGraphLabel("@suibari.com"), false);
  assert.equal(isPublishableGraphLabel("＠すいばり"), false);
  assert.equal(isPublishableGraphLabel("did:plc:abcdef"), false);
  assert.equal(isPublishableGraphLabel("https://example.com/x"), false);
  assert.equal(isPublishableGraphLabel("example.com/path"), false);
  // 本文を丸ごと持ってきたような長い抽出
  assert.equal(isPublishableGraphLabel("あ".repeat(41)), false);
  assert.equal(isPublishableGraphLabel("あ".repeat(40)), true);
});

test("裏付けが1件しかないラベルはノードにしない", () => {
  const nodes = selectBotMemoryGraphNodes(
    [nodeRow({ key: "a", label: "A", occurrences: 1 }), nodeRow({ key: "b", label: "B", occurrences: 2 })],
    [],
    { now: NOW },
  );
  assert.deepEqual(nodes.map((node) => node.id), ["b"]);
});

test("未評価の印象度は 0 に潰さず null のまま返す", () => {
  const [node] = selectBotMemoryGraphNodes([nodeRow({ salience: null, scoredCount: 0 })], [], { now: NOW });
  assert.equal(node!.salience, null);
  assert.equal(node!.scoredCount, 0);
});

test("未評価は中立値として順位付けされ、評価済みの低印象より上に来る", () => {
  const shared = { occurrences: 3, latestAt: new Date("2026-09-01T00:00:00Z") };
  const unscored = scoreBotMemoryGraphNode({ ...shared, salience: null }, NOW);
  const scoredLow = scoreBotMemoryGraphNode({ ...shared, salience: 10 }, NOW);
  const scoredHigh = scoreBotMemoryGraphNode({ ...shared, salience: 90 }, NOW);
  assert.ok(unscored > scoredLow);
  assert.ok(scoredHigh > unscored);
});

test("鮮度は古いほど効きが落ちる", () => {
  const shared = { salience: 70, occurrences: 3 };
  const fresh = scoreBotMemoryGraphNode({ ...shared, latestAt: new Date("2026-09-04T00:00:00Z") }, NOW);
  const stale = scoreBotMemoryGraphNode({ ...shared, latestAt: new Date("2025-09-04T00:00:00Z") }, NOW);
  assert.ok(fresh > stale);
  // 未来日時（時計ずれ）でスコアが跳ねない
  const future = scoreBotMemoryGraphNode({ ...shared, latestAt: new Date("2026-10-01T00:00:00Z") }, NOW);
  assert.equal(future, scoreBotMemoryGraphNode({ ...shared, latestAt: NOW }, NOW));
});

test("読みは大文字小文字を畳んで突き合わせる", () => {
  const nodes = selectBotMemoryGraphNodes(
    [nodeRow({ key: "madoka magica", label: "Madoka Magica" })],
    [{ surface: "Madoka Magica", spokenForm: "まどかまぎか" }],
    { now: NOW },
  );
  assert.equal(nodes[0]!.spokenForm, "まどかまぎか");
});

test("読みが無いラベルは null", () => {
  const nodes = selectBotMemoryGraphNodes([nodeRow()], [{ surface: "別のもの", spokenForm: "べつ" }], { now: NOW });
  assert.equal(nodes[0]!.spokenForm, null);
});

test("上限を超えたら印象度と鮮度の高い順に切る", () => {
  const rows = [
    nodeRow({ key: "low", label: "low", salience: 10 }),
    nodeRow({ key: "high", label: "high", salience: 95 }),
    nodeRow({ key: "mid", label: "mid", salience: 50 }),
  ];
  const nodes = selectBotMemoryGraphNodes(rows, [], { now: NOW, limit: 2 });
  assert.deepEqual(nodes.map((node) => node.id), ["high", "mid"]);
});

test("同点の並びは実行のたびに揺れない", () => {
  const rows = [
    nodeRow({ key: "b", label: "b" }),
    nodeRow({ key: "a", label: "a" }),
    nodeRow({ key: "c", label: "c" }),
  ];
  const first = selectBotMemoryGraphNodes(rows, [], { now: NOW }).map((node) => node.id);
  const second = selectBotMemoryGraphNodes([...rows].reverse(), [], { now: NOW }).map((node) => node.id);
  assert.deepEqual(first, second);
});

test("知らない kind / relation は既定へ寄せる", () => {
  const [node] = selectBotMemoryGraphNodes(
    [nodeRow({ kind: "unknown", relation: "unknown" })],
    [],
    { now: NOW },
  );
  assert.equal(node!.kind, "word");
  assert.equal(node!.relation, "discussed");
});

test("共起があるペアには類似エッジを重ねない", () => {
  const edges = mergeBotMemoryGraphEdges(
    [{ source: "a", target: "b", weight: 3 }],
    [
      { source: "a", target: "b", similarity: 0.9 },
      { source: "b", target: "c", similarity: 0.8 },
    ],
    ["a", "b", "c"],
  );
  assert.deepEqual(edges, [
    { source: "a", target: "b", type: "cooccurrence", weight: 3 },
    { source: "b", target: "c", type: "similarity", similarity: 0.8 },
  ]);
});

test("向きが逆でも同じペアとみなす", () => {
  const edges = mergeBotMemoryGraphEdges(
    [{ source: "b", target: "a", weight: 3 }],
    [{ source: "a", target: "b", similarity: 0.9 }],
    ["a", "b"],
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.type, "cooccurrence");
});

test("ノードに無い端点と自己ループは落とす", () => {
  const edges = mergeBotMemoryGraphEdges(
    [
      { source: "a", target: "ghost", weight: 3 },
      { source: "a", target: "a", weight: 5 },
    ],
    [{ source: "ghost", target: "b", similarity: 0.9 }],
    ["a", "b"],
  );
  assert.deepEqual(edges, []);
});

test("類似度は 4 桁に丸めて返す", () => {
  const [edge] = mergeBotMemoryGraphEdges([], [{ source: "a", target: "b", similarity: 0.812345678 }], ["a", "b"]);
  assert.deepEqual(edge, { source: "a", target: "b", type: "similarity", similarity: 0.8123 });
});

test("公開ノードに本文や識別子の鍵が混ざらない", () => {
  const nodes = selectBotMemoryGraphNodes([nodeRow()], [], { now: NOW });
  assert.deepEqual(Object.keys(nodes[0]!).sort(), [
    "id",
    "kind",
    "label",
    "latestAt",
    "occurrences",
    "relation",
    "salience",
    "scoredCount",
    "spokenForm",
  ]);
});
