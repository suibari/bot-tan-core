import assert from "node:assert/strict";
import test from "node:test";
// db.ts が接続文字列を要求するので、import より先にダミーを入れておく。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { db } = await import("@bsky-affirmative-bot/database");
const { loadTagCounts, rankTagSuggestions, searchTags } = await import(
  "../src/queries/tagSuggestions.js"
);

const tags = [
  { tag: "さんぽ", count: 12 },
  { tag: "nagi", count: 8 },
  { tag: "さんぽ日和", count: 3 },
  { tag: "nagi開発", count: 2 },
  { tag: "おさんぽ", count: 1 },
];

test("rankTagSuggestions matches by prefix and keeps the post-count order", () => {
  assert.deepEqual(
    rankTagSuggestions(tags, "さんぽ", 10).map((t) => t.tag),
    ["さんぽ", "さんぽ日和"],
  );
});

test("rankTagSuggestions ignores the marker and case like normalizeTag", () => {
  assert.deepEqual(
    rankTagSuggestions(tags, "＃NAGI", 10).map((t) => t.tag),
    ["nagi", "nagi開発"],
  );
});

test("rankTagSuggestions honors the limit and returns nothing for an empty query", () => {
  assert.deepEqual(rankTagSuggestions(tags, "nagi", 1), [{ tag: "nagi", count: 8 }]);
  assert.deepEqual(rankTagSuggestions(tags, "#", 10), []);
});

test("searchTags does not hit the database for an empty query", async () => {
  assert.deepEqual(await searchTags("  # ", 10), { tags: [] });
});

test("loadTagCounts only counts posts that the shared timeline shows", async () => {
  const original = db.execute;
  let rendered = "";
  (db as any).execute = async (query: any) => {
    rendered = db.dialect.sqlToQuery(query).sql.replace(/\s+/g, " ");
    return [{ tag: "さんぽ", count: "2" }];
  };
  try {
    assert.deepEqual(await loadTagCounts(), [{ tag: "さんぽ", count: 2 }]);
  } finally {
    (db as any).execute = original;
  }
  assert.match(rendered, /"deleted_at" is null/);
  assert.match(rendered, /not "nagi"\."posts"\."kossori"/);
  assert.match(rendered, /select not thread_root\.kossori/);
  assert.match(rendered, /"moderation_version" is not null/);
  assert.match(rendered, /join nagi\.channels as channel/);
  assert.match(rendered, /count\(distinct tagged\.uri\)/);
});
