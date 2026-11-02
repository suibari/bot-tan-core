import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and, eq } = await import("drizzle-orm");
const { kossoriVisibility } = await import("../src/queries/timeline.js");
const { NAGI, appviewRecordUri, isAppviewOwnedUri } = await import(
  "@bsky-affirmative-bot/nagi-lexicon"
);

const render = (...conditions: Parameters<typeof and>) => {
  const rendered = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(...conditions))
    .toSQL();
  return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
};

test("profile feeds hide other people's kossori threads", () => {
  const { text, params } = render(kossoriVisibility("did:plc:self"));
  // ルート投稿は自分のものだけ通す。
  assert.ok(
    text.includes('not "nagi"."posts"."kossori" or "nagi"."posts"."did" = $'),
    text,
  );
  // 返信はルート行で判定する。
  assert.ok(text.includes("from nagi.posts as thread_root"), text);
  assert.ok(text.includes("thread_root.kossori"), text);
  assert.ok(text.includes("thread_root.did = $"), text);
  assert.ok(params.includes("did:plc:self"));
});

test("unauthenticated viewers never match the kossori author", () => {
  const { text, params } = render(kossoriVisibility(undefined));
  // viewer が居ないときは「自分の投稿」に当たりようがないので false で束縛しない。
  assert.ok(text.includes('not "nagi"."posts"."kossori" or false'), text);
  assert.ok(text.includes("and not (false)"), text);
  assert.equal(
    params.some((param) => String(param).startsWith("did:")),
    false,
  );
});

test("replies whose root is missing stay visible on the profile", () => {
  // ルート未取り込みの返信までプロフィールから消さないため、ここは exists の否定にしてある
  // （共有TL側の coalesce(..., false) による fail closed とは意図的に形が違う）。
  const { text } = render(kossoriVisibility("did:plc:self"));
  assert.ok(text.includes("else not exists ("), text);
  assert.equal(text.includes("coalesce("), false);
});

test("kossori rows are excluded from the repo reconcile sweep", () => {
  // reconcileRepo の localRecords は「PDS に無いローカル行」を消す。こっそり投稿は
  // そもそも PDS に正本が無いので、この条件を落とすと reconcile のたびに全部消える。
  const { text } = render(
    eq(nagiPosts.did, "did:plc:self"),
    eq(nagiPosts.appviewOnly, false),
  );
  assert.ok(text.includes('"appview_only" = $'), text);
});

test("appview-owned URIs carry no author DID", () => {
  const uri = appviewRecordUri(NAGI.post, "abc123");
  assert.equal(uri, "at://did:web:nagi-api.suibari.com/com.suibari.nagi.post/abc123");
  assert.equal(isAppviewOwnedUri(uri), true);
  assert.equal(
    isAppviewOwnedUri("at://did:plc:alice/com.suibari.nagi.post/abc123"),
    false,
  );
});
