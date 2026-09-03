import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applyMutation = await readFile(
  new URL("../src/ingest/applyMutation.ts", import.meta.url),
  "utf8",
);

test("Nagi reactions keep their projection and notifications without RAG documents", () => {
  assert.match(applyMutation, /insert\(nagiReactions\)/);
  assert.match(applyMutation, /type: "reaction"/);
  assert.doesNotMatch(applyMutation, /nagi_received_reaction|formatReactionMemoryContent/);
});
