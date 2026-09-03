import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const callbacks = await readFile(
  new URL("../src/bsky/callbacks.ts", import.meta.url),
  "utf8",
);

test("Bluesky likes keep operational handling without creating RAG documents", () => {
  assert.match(callbacks, /botBiothythmManager\.addLike\(\)/);
  assert.match(callbacks, /MemoryService\.upsertLike/);
  assert.match(callbacks, /MemoryService\.logUsage\('like'/);
  assert.doesNotMatch(callbacks, /bsky_received_like|formatReactionMemoryContent/);
});
