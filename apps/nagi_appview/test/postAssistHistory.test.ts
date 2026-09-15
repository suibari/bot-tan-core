import assert from "node:assert/strict";
import test from "node:test";
import { PostAssistHistory } from "../src/services/postAssistHistory.js";

const entry = (key: string) => ({ kind: "interest" as const, key, message: `message ${key}` });

test("returns entries oldest first and forgets them after the TTL", () => {
  let now = 1_000;
  const history = new PostAssistHistory({ now: () => now, ttlMs: 100 });
  history.record("did:a", entry("1"));
  now = 1_050;
  history.record("did:a", entry("2"));
  assert.deepEqual(history.get("did:a").map((item) => item.key), ["1", "2"]);
  now = 1_120;
  assert.deepEqual(history.get("did:a").map((item) => item.key), ["2"]);
  now = 1_200;
  assert.deepEqual(history.get("did:a"), []);
  assert.equal(history.size, 0);
});

test("keeps only the latest entries per actor", () => {
  const history = new PostAssistHistory({ perActor: 3 });
  for (const key of ["1", "2", "3", "4", "5"]) history.record("did:a", entry(key));
  assert.deepEqual(history.get("did:a").map((item) => item.key), ["3", "4", "5"]);
});

test("evicts the actor that was updated least recently", () => {
  const history = new PostAssistHistory({ maxActors: 2 });
  history.record("did:a", entry("a"));
  history.record("did:b", entry("b"));
  history.record("did:a", entry("a2"));
  history.record("did:c", entry("c"));
  assert.equal(history.size, 2);
  assert.deepEqual(history.get("did:b"), []);
  assert.equal(history.get("did:a").length, 2);
  assert.equal(history.get("did:c").length, 1);
});
