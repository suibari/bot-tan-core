import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and } = await import("drizzle-orm");
const {
  latestThreadActivity,
  orderThreadRepresentatives,
  restoreSearchResultOrder,
} = await import("../src/queries/timeline.js");

const at = (minute: number) =>
  new Date(`2026-08-08T00:${String(minute).padStart(2, "0")}:00Z`);
const row = (
  uri: string,
  did: string,
  minute: number,
  replyRootUri: string | null = null,
  replyParentUri: string | null = null,
) => ({
  post: { uri, did, indexedAt: at(minute), replyRootUri, replyParentUri },
});

test("a newer human reply moves the whole thread above a newer root", () => {
  const rootA = row("at://a/post/root-a", "did:plc:a", 1);
  const rootB = row("at://b/post/root-b", "did:plc:b", 2);
  const replyA = row(
    "at://c/post/reply-a",
    "did:plc:c",
    3,
    rootA.post.uri,
    rootA.post.uri,
  );

  const ordered = orderThreadRepresentatives([rootA, rootB, replyA]);
  assert.deepEqual(
    ordered.map((item) => item.post.uri),
    [replyA.post.uri, rootB.post.uri],
  );
});

test("bot replies stay in the thread but do not change its representative or rank", () => {
  const rootA = row("at://a/post/root-a", "did:plc:a", 1);
  const rootB = row("at://b/post/root-b", "did:plc:b", 2);
  const botReplyA = row(
    "at://bot/post/reply-a",
    "did:plc:bot",
    4,
    rootA.post.uri,
    rootA.post.uri,
  );

  const ordered = orderThreadRepresentatives(
    [rootA, rootB, botReplyA],
    "did:plc:bot",
  );
  assert.deepEqual(
    ordered.map((item) => item.post.uri),
    [rootB.post.uri, rootA.post.uri],
  );
});

test("bot top-level posts remain activities and equal timestamps use URI descending", () => {
  const botRoot = row("at://bot/post/z", "did:plc:bot", 5);
  const humanRoot = row("at://human/post/a", "did:plc:human", 5);

  const ordered = orderThreadRepresentatives(
    [humanRoot, botRoot],
    "did:plc:bot",
  );
  assert.deepEqual(
    ordered.map((item) => item.post.uri),
    [humanRoot.post.uri, botRoot.post.uri],
  );
});

test("the representative SQL uses the same thread key, bot exception, and stable tie-break", () => {
  const query = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(latestThreadActivity({ actors: [], tags: [] }, false)));
  const rendered = query.toSQL();
  const text = rendered.sql.replace(/\s+/g, " ");

  assert.ok(text.includes("coalesce(sib.reply_root_uri, sib.uri) = coalesce("));
  assert.ok(text.includes("sib.did <>"));
  assert.ok(text.includes("sib.reply_parent_uri is null"));
  assert.ok(text.includes("sib.indexed_at >"));
  assert.ok(text.includes("sib.indexed_at ="));
  assert.ok(text.includes("sib.uri >"));
  assert.ok(rendered.params.includes("did:plc:bot"));
});

test("search hydration preserves exact or semantic SQL order", () => {
  const rows = [
    { post: { uri: "semantic-second" } },
    { post: { uri: "root-first" } },
    { post: { uri: "reply-third" } },
  ];
  const hydrated = new Map([
    ["reply-third", { uri: "reply-third", kind: "reply" }],
    ["root-first", { uri: "root-first", kind: "conversation" }],
    ["semantic-second", { uri: "semantic-second", kind: "conversation" }],
  ]);

  assert.deepEqual(
    restoreSearchResultOrder(rows, hydrated).map((item) => item.uri),
    rows.map((item) => item.post.uri),
  );
});
