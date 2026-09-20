import assert from "node:assert/strict";
import test from "node:test";
// db.ts が接続文字列を、config.ts が bot DID を要求するので、値の import より先に置く
// （どちらも実際には接続・解決しない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:testbot";

const { db, nagiNews, nagiNewsApprovals } = await import(
  "@bsky-affirmative-bot/database"
);
const { approvedNewsConditions, getNewsItemByRkey, newsAdultVisibility } =
  await import("../src/queries/positiveNews.js");
const { and, eq } = await import("drizzle-orm");

/** 条件配列を SQL 文字列にして中身を見る。 */
const render = (conditions: ReturnType<typeof approvedNewsConditions>) =>
  db
    .select({ uri: nagiNews.uri })
    .from(nagiNews)
    .innerJoin(nagiNewsApprovals, eq(nagiNewsApprovals.newsUri, nagiNews.uri))
    .where(and(...conditions))
    .toSQL().sql;

test("approved news are filtered by the admin hide flag", () => {
  // hide は status も落とすが、再公開の onConflict が status を戻しうるので、
  // 「隠した」事実そのものを見ていることを固定する。
  assert.match(render(approvedNewsConditions()), /hidden_at"? is null/);
});

test("the indexing path drops the predicate that needs the actor join", () => {
  const joined = approvedNewsConditions();
  const standalone = approvedNewsConditions({ actorJoined: false });
  assert.equal(joined.length, standalone.length + 1);
  // nagiActors を join しない呼び出し側が、その列を参照する条件を持ち込まないこと。
  assert.doesNotMatch(render(standalone), /actors/);
  assert.match(render(joined), /actors/);
});

test("adult news are hidden from minors and from crawlers", () => {
  assert.deepEqual(newsAdultVisibility(true), []);
  const minor = newsAdultVisibility(false);
  assert.equal(minor.length, 2);
  const sql = render(minor);
  // 判定待ち（moderation_version is null）も落とす。非同期判定の露出窓を閉じるため。
  assert.match(sql, /moderation_version"? is not null/);
  assert.match(sql, /moderation_labels/);
});

test("a malformed permalink rkey is rejected before the database is touched", async () => {
  // rkey は sha256(articleId).slice(0, 32)。URL の形をそのままクエリへ通さない。
  for (const rkey of [
    "",
    "not-a-hash",
    "ABCDEF0123456789abcdef0123456789",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "'; drop table nagi.news; --",
  ]) {
    assert.equal(await getNewsItemByRkey({ rkey, lang: "ja" }), null);
  }
});
