import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";
const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and } = await import("drizzle-orm");
const { timelineVisibilityFilters, searchPostVisibility } = await import("../src/queries/timeline.js");
const ctx = {
  mutes: { actors: [], tags: [] }, muteActors: false, muteTags: false, isAdult: true,
};
const render = (conditions: Parameters<typeof and>) => db
  .select({ uri: nagiPosts.uri }).from(nagiPosts).where(and(...conditions)).toSQL();

for (const opts of [{}, { affirmation: true }]) {
  for (const viewerDid of [undefined, "did:plc:self"]) {
    test(`shared feed excludes all kossori: ${JSON.stringify({ ...opts, viewerDid })}`, () => {
      const { sql, params } = render(timelineVisibilityFilters({ ...opts, viewerDid }, ctx));
      assert.match(sql, /then not "nagi"\."posts"\."kossori"/);
      assert.match(sql, /select not thread_root\.kossori/);
      assert.match(sql, /coalesce\(/);
      assert.equal(params.includes("did:plc:self"), false);
    });
  }
}

test("only the viewer's own profile permits their kossori threads", () => {
  for (const actorDid of ["did:plc:self", "did:plc:other"]) {
    const { sql } = render(timelineVisibilityFilters({ actorDid, viewerDid: "did:plc:self" }, ctx));
    assert.equal(/kossori" or "nagi"\."posts"\."did" =/.test(sql), actorDid === "did:plc:self");
    assert.equal(/thread_root.did =/.test(sql), actorDid === "did:plc:self");
  }
});

test("text search includes only the viewer own kossori threads", async () => {
  const source = await readFile(new URL("../src/queries/search.ts", import.meta.url), "utf8");
  assert.match(source, /searchPostVisibility\(opts.viewerDid\)/);
  for (const viewerDid of [undefined, "did:plc:self"]) {
    const { sql, params } = render([searchPostVisibility(viewerDid)]);
    assert.equal(params.includes("did:plc:self"), Boolean(viewerDid));
    assert.equal(sql.includes("thread_root.did ="), Boolean(viewerDid));
  }
});

for (const viewerDid of [undefined, "did:plc:self"]) {
  test(`tag search permits only the viewer own kossori: ${viewerDid}`, () => {
    const { sql, params } = render(timelineVisibilityFilters({ tag: "test", viewerDid }, ctx));
    assert.equal(params.includes("did:plc:self"), Boolean(viewerDid));
    assert.equal(sql.includes("thread_root.did ="), Boolean(viewerDid));
  });
}
