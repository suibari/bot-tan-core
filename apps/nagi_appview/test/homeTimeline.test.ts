import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and } = await import("drizzle-orm");
const {
  homeRootVisibility,
  homeSiblingFilter,
  homeTimelineVisibility,
  profileThreadMatch,
} = await import("../src/queries/timeline.js");

const ACTORS = ["did:plc:self", "did:plc:bot", "did:plc:member"];

const render = (conditions: Parameters<typeof and>) => {
  const query = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(...conditions));
  const rendered = query.toSQL();
  return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
};

test("home visibility keeps replies as candidates and judges scope on the thread root", () => {
  const { text, params } = render(
    homeTimelineVisibility("did:plc:self", ACTORS),
  );
  // 返信もホームの候補にする（スレッド単位の最新活動順にするため）。
  assert.ok(!text.includes('"reply_parent_uri" is null'));
  // 公開範囲はスレッドルート行で判定する。
  assert.ok(text.includes("exists ( select 1 from nagi.posts as thread_root"));
  assert.ok(
    text.includes("not thread_root.kossori or thread_root.did = $"),
    text,
  );
  // 候補の著者はリストメンバーに限る。
  assert.ok(text.includes('"did" in ('));
  for (const did of ACTORS)
    assert.ok(params.includes(did), `missing bound actor ${did}`);
  // DID 集合は text[] として1回だけ束縛する（レコード構成子に展開させない）。
  assert.ok(params.some((param) => Array.isArray(param)));
});

test("home representative is the list member's latest post in the thread", () => {
  // 兄弟をメンバーに限らないと、リスト外の人の返信が代表になり、その代表が候補条件で
  // 落ちてスレッドごとホームから消える。共有TL（homeDid なし）では足さない。
  const { text, params } = render([homeSiblingFilter(ACTORS)]);
  assert.ok(text.includes("sib.did = any($"));
  assert.ok(params.some((param) => Array.isArray(param)));
  assert.equal(render([homeSiblingFilter(undefined)]).text.includes("sib.did"), false);
});

test("my Nagi list section stays root-only", () => {
  const { text, params } = render(homeRootVisibility("did:plc:self", ACTORS));
  assert.ok(text.includes('"reply_parent_uri" is null'));
  assert.ok(text.includes('"did" = $') && text.includes('"kossori" = $'));
  for (const did of ACTORS)
    assert.ok(params.includes(did), `missing bound actor ${did}`);
});

test("profile filters qualify whole threads before the latest activity is selected", () => {
  const posts = render([profileThreadMatch("did:plc:actor", "posts")]);
  assert.ok(
    posts.text.includes("exists ( select 1 from nagi.posts as candidate"),
  );
  assert.ok(posts.text.includes("candidate.reply_parent_uri is null"));
  assert.ok(posts.params.includes("did:plc:actor"));

  const replies = render([profileThreadMatch("did:plc:actor", "replies")]);
  assert.ok(replies.text.includes("candidate.reply_parent_uri is not null"));

  const media = render([profileThreadMatch("did:plc:actor", "media")]);
  assert.ok(media.text.includes("candidate.embed_images"));
  assert.ok(media.text.includes("jsonb_array_length"));
});
