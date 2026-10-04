import assert from "node:assert/strict";
import test from "node:test";
import { MemoryService } from "../src/index.js";

test("ラジオの放送対象は期間内の投稿で絞り、timestampはDrizzleの列エンコーダを通る", () => {
  const query = MemoryService.buildNagiRadioAudienceQuery(new Date("2026-09-27T12:00:00.000Z")).toSQL();
  assert.match(query.sql, /record_created_at.*>=/);
  assert.doesNotMatch(query.sql, /bot_memory_documents/);
  assert.ok(query.params.every((param) => !(param instanceof Date)));
  assert.ok(query.params.includes("2026-09-27T12:00:00.000Z"));
  assert.ok(query.params.includes("active"));
});
