import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";
const { recommendedNewsQuery } = await import("../src/queries/positiveNews.js");

test("recommendations include every matched article, including recent and old news, newest first", () => {
  const uris = Array.from({ length: 40 }, (_, i) => `at://news/${i}`);
  const query = recommendedNewsQuery(uris, { actors: [], channels: [] }).toSQL();
  for (const uri of uris) assert.ok(query.params.includes(uri));
  assert.doesNotMatch(query.sql, /\blimit\b|\boffset\b|\binterval\b|embedding" is not null/i);
  assert.match(query.sql, /order by coalesce\(.*snapshot_created_at.*record_created_at.*\) desc/);
  assert.match(query.sql, /deleted_at" is null/);
  assert.match(query.sql, /hidden_at" is null/);
  assert.ok(query.params.includes("approved"));
});

test("recommendations preserve age visibility rules", () => {
  const query = recommendedNewsQuery(["at://news/1"], { actors: [], channels: [] }, false).toSQL();
  assert.match(query.sql, /moderation_version" is not null/);
  assert.match(query.sql, /moderation_labels" &&/);
});

test("recommendations still exclude muted authors", () => {
  const query = recommendedNewsQuery(["at://news/1"], { actors: ["did:plc:muted"], channels: [] }).toSQL();
  assert.ok(query.params.includes("did:plc:muted"));
  assert.match(query.sql, /"did" not in/);
});
