import assert from "node:assert/strict";
import test from "node:test";
import { followUpDueAt } from "../src/botMemory.js";

test("予定の期日は発言時刻から段階ごとに後ろへずらす", () => {
  const occurredAt = new Date("2026-10-24T00:00:00Z");
  assert.equal(followUpDueAt(occurredAt, "today").toISOString(), "2026-10-24T06:00:00.000Z");
  assert.equal(followUpDueAt(occurredAt, "tomorrow").toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(followUpDueAt(occurredAt, "this_week").toISOString(), "2026-10-27T00:00:00.000Z");
});
