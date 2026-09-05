import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and } = await import("drizzle-orm");
const { timelineVisibilityFilters } = await import("../src/queries/timeline.js");
const {
  decodeAffirmationCursor,
  encodeAffirmationCursor,
  interleave,
} = await import("../src/queries/personalizedFeed.js");

const render = (conditions: any[]) => {
  const rendered = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(...conditions))
    .toSQL();
  return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
};

/**
 * 動的枠は timelineVisibilityFilters を時系列側と共有している。ここが分岐して
 * 条件が1つでも欠けると、隠れているべき投稿が「あなたに近い」として漏れる。
 */
const affirmationFilters = (opts: {
  viewerDid: string;
  mutes?: { actors: string[]; channels: string[] };
  isAdult?: boolean;
}) =>
  timelineVisibilityFilters(
    { viewerDid: opts.viewerDid, affirmation: true },
    {
      mutes: opts.mutes ?? { actors: [], channels: [] },
      muteActors: Boolean(opts.mutes?.actors.length),
      muteChannels: Boolean(opts.mutes?.channels.length),
      isAdult: opts.isAdult ?? true,
    },
  );

test("dynamic slots keep other people's kossori threads hidden", () => {
  const { text, params } = render(
    affirmationFilters({ viewerDid: "did:plc:self" }),
  );
  // ルート投稿は自分のものだけ、返信はスレッドルートで判定。
  assert.ok(text.includes('not "nagi"."posts"."kossori" or "nagi"."posts"."did" = $'), text);
  assert.ok(text.includes("from nagi.posts as thread_root"), text);
  // ルート未解決は fail closed（共有TLと同じ）。
  assert.ok(text.includes("coalesce("), text);
  assert.ok(params.includes("did:plc:self"));
});

test("dynamic slots apply actor and channel mutes", () => {
  const { text, params } = render(
    affirmationFilters({
      viewerDid: "did:plc:self",
      mutes: { actors: ["did:plc:muted"], channels: ["at://ch"] },
    }),
  );
  assert.ok(params.some((p) => String(p).includes("did:plc:muted")), text);
  assert.ok(params.some((p) => String(p).includes("at://ch")), text);
});

test("dynamic slots drop adult and unjudged posts for minors", () => {
  const { text } = render(
    affirmationFilters({ viewerDid: "did:plc:self", isAdult: false }),
  );
  assert.ok(text.includes('"nagi"."posts"."moderation_version" is not null'), text);
  assert.ok(text.includes('"nagi"."posts"."moderation_labels" &&'), text);
  assert.ok(text.includes('"nagi"."posts"."self_labels" &&'), text);
});

test("adults are not filtered by the adult conditions", () => {
  const { text } = render(
    affirmationFilters({ viewerDid: "did:plc:self", isAdult: true }),
  );
  assert.equal(text.includes('"nagi"."posts"."moderation_version" is not null'), false);
});

test("dynamic slots still require the affirmation score threshold", () => {
  const { text } = render(affirmationFilters({ viewerDid: "did:plc:self" }));
  assert.ok(text.includes('"nagi"."post_scores"."score" >='), text);
});

test("bot replies never become dynamic slots", () => {
  const { text } = render(affirmationFilters({ viewerDid: "did:plc:self" }));
  assert.ok(text.includes('"nagi"."posts"."reply_parent_uri" is null'), text);
});

test("interleave inserts dynamic items without reordering the timeline", () => {
  const base = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const out = interleave(base, ["X", "Y"], 3);
  assert.deepEqual(out, ["a", "b", "c", "X", "d", "e", "f", "Y", "g", "h"]);
  // 時系列の相対順序は保たれる。
  assert.deepEqual(out.filter((v) => !["X", "Y"].includes(v)), base);
});

test("interleave appends leftovers when the timeline page is short", () => {
  assert.deepEqual(interleave(["a"], ["X", "Y"], 3), ["a", "X", "Y"]);
});

test("interleave returns the timeline untouched when there is nothing to insert", () => {
  const base = ["a", "b"];
  assert.equal(interleave(base, [], 3), base);
});

test("affirmation cursor round-trips the dynamic offset", () => {
  const cursor = encodeAffirmationCursor("BASE", 4);
  assert.deepEqual(decodeAffirmationCursor(cursor), {
    base: "BASE",
    dynOffset: 4,
  });
});

test("a legacy timeline cursor is read as the base cursor", () => {
  // 移行中のクライアントが送ってくる素の時系列カーソル（JSON 配列）。
  const legacy = Buffer.from(
    JSON.stringify(["2026-01-01T00:00:00.000Z", "at://post"]),
  ).toString("base64url");
  assert.deepEqual(decodeAffirmationCursor(legacy), {
    base: legacy,
    dynOffset: 0,
  });
});

test("no cursor means the first page and no dynamic offset", () => {
  assert.deepEqual(decodeAffirmationCursor(undefined), { dynOffset: 0 });
});
