import assert from "node:assert/strict";
import test from "node:test";
// db.ts が接続文字列を要求するので、import より先にダミーを入れておく（toSQL は接続しない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { EMPTY_MUTES } = await import("../src/queries/mutes.js");
const { indexableBlogConditions } = await import("../src/queries/indexableBlogs.js");

const render = (where: ReturnType<typeof indexableBlogConditions>) => {
  const { sql, params } = db.select({ uri: nagiPosts.uri }).from(nagiPosts).where(where).toSQL();
  return { text: sql.replace(/\s+/g, " "), params };
};

test("閲覧者なしの一覧はミュートの条件を含まない", () => {
  const { text } = render(indexableBlogConditions(EMPTY_MUTES));
  assert.ok(!text.includes('"did" not in'));
  assert.ok(!text.includes('"tags"'));
});

test("閲覧者付きの一覧はミュートした作者とタグを除く", () => {
  const { text, params } = render(
    indexableBlogConditions({ actors: ["did:plc:muted"], tags: ["noise"] }),
  );
  assert.ok(text.includes('"did" not in'));
  assert.ok(params.includes("did:plc:muted"));
  assert.ok(JSON.stringify(params).includes("noise"));
});
