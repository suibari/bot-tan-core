import assert from "node:assert/strict";
import test from "node:test";
import { orderThreadReplies } from "../src/queries/threadOrder.js";

type Node = { uri: string; parentUri?: string | null; time: number };
const order = (rootUri: string, nodes: Node[]) =>
  orderThreadReplies(rootUri, nodes, (n) => n).map((n) => n.uri);

test("keeps a later reply under its parent instead of after an unrelated sibling", () => {
  // ルートA → A1 → B → (A1への)A2 は「B, A1, A2」になる。
  assert.deepEqual(
    order("A", [
      { uri: "A1", parentUri: "A", time: 1 },
      { uri: "B", parentUri: "A", time: 2 },
      { uri: "A2", parentUri: "A1", time: 3 },
    ]),
    ["B", "A1", "A2"],
  );
});

test("orders sibling branches by their latest activity", () => {
  assert.deepEqual(
    order("R", [
      { uri: "x", parentUri: "R", time: 1 },
      { uri: "y", parentUri: "R", time: 2 },
      { uri: "x1", parentUri: "x", time: 3 },
      { uri: "y1", parentUri: "y", time: 4 },
    ]),
    ["x", "x1", "y", "y1"],
  );
});

test("is plain chronological for a linear conversation", () => {
  assert.deepEqual(
    order("R", [
      { uri: "c", parentUri: "b", time: 3 },
      { uri: "a", parentUri: "R", time: 1 },
      { uri: "b", parentUri: "a", time: 2 },
    ]),
    ["a", "b", "c"],
  );
});

test("treats replies with a missing parent as direct replies to the root", () => {
  assert.deepEqual(
    order("R", [
      { uri: "a", parentUri: "R", time: 1 },
      { uri: "orphan", parentUri: "deleted", time: 2 },
      { uri: "noParent", time: 3 },
    ]),
    ["a", "orphan", "noParent"],
  );
});

test("returns every item once even with cyclic parent references", () => {
  const result = order("R", [
    { uri: "a", parentUri: "R", time: 1 },
    { uri: "p", parentUri: "q", time: 2 },
    { uri: "q", parentUri: "p", time: 3 },
    { uri: "self", parentUri: "self", time: 4 },
  ]);
  assert.deepEqual([...result].sort(), ["a", "p", "q", "self"]);
  assert.equal(result[0], "a");
});

test("excludes the root itself", () => {
  assert.deepEqual(
    order("R", [
      { uri: "R", time: 0 },
      { uri: "a", parentUri: "R", time: 1 },
    ]),
    ["a"],
  );
});
