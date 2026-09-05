import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and } = await import("drizzle-orm");
const { timelineVisibilityFilters } = await import("../src/queries/timeline.js");
const { dailyBestPerAuthor } = await import("../src/queries/timeline.js");

const render = (conditions: any[]) => {
  const rendered = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(...conditions))
    .toSQL();
  return { text: rendered.sql.replace(/\s+/g, " "), params: rendered.params };
};

/** 全肯定TLの可視性条件。ここが欠けると隠れているべき投稿が漏れる。 */
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

test("the affirmation feed keeps other people's kossori threads hidden", () => {
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

test("the affirmation feed applies actor and channel mutes", () => {
  const { text, params } = render(
    affirmationFilters({
      viewerDid: "did:plc:self",
      mutes: { actors: ["did:plc:muted"], channels: ["at://ch"] },
    }),
  );
  assert.ok(params.some((p) => String(p).includes("did:plc:muted")), text);
  assert.ok(params.some((p) => String(p).includes("at://ch")), text);
});

test("the affirmation feed drops adult and unjudged posts for minors", () => {
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

test("the affirmation feed requires the score threshold", () => {
  const { text } = render(affirmationFilters({ viewerDid: "did:plc:self" }));
  assert.ok(text.includes('"nagi"."post_scores"."score" >='), text);
});

test("bot replies never appear in the affirmation feed", () => {
  const { text } = render(affirmationFilters({ viewerDid: "did:plc:self" }));
  assert.ok(text.includes('"nagi"."posts"."reply_parent_uri" is null'), text);
});

/**
 * 1人1日1投稿。**見えない投稿に代表を取らせると、その日のその人の投稿が丸ごと消える**
 * ので、兄弟側にも本体と同じ可視性条件が要る。ここが本命の回帰テスト。
 */
test("the daily-best pick only competes against posts the viewer can see", () => {
  const { text, params } = render([dailyBestPerAuthor("did:plc:self", false)]);
  // 同一著者・同一JST日で比べる。
  assert.ok(text.includes("best.did ="), text);
  assert.ok(text.includes("at time zone 'Asia/Tokyo'"), text);
  // こっそりはスレッドルートで判定し、ルート未解決なら代表になれない（fail closed）。
  assert.ok(text.includes("best_root.kossori"), text);
  assert.ok(text.includes("coalesce("), text);
  // 未成年ビューアには成人向け・判定待ちを代表にさせない。
  assert.ok(text.includes("best.moderation_version is not null"), text);
  // スコア未満・削除済み・botの返信は争いに参加しない。
  assert.ok(text.includes("best_score.score >="), text);
  assert.ok(text.includes("best.deleted_at is null"), text);
  assert.ok(text.includes("best.reply_parent_uri is null"), text);
  assert.ok(params.includes("did:plc:self"));
});

test("adults do not get the adult guard inside the daily-best subquery", () => {
  const { text } = render([dailyBestPerAuthor("did:plc:self", true)]);
  assert.equal(text.includes("best.moderation_version is not null"), false);
});

test("the daily-best tie-break is total, so exactly one post survives per day", () => {
  const { text } = render([dailyBestPerAuthor("did:plc:self", false)]);
  // スコア → indexed_at → uri の順で必ず決着する（同点で2件残らない）。
  assert.ok(text.includes("best_score.score >"), text);
  assert.ok(text.includes("best.indexed_at >"), text);
  assert.ok(text.includes("best.uri >"), text);
});

test("a signed-out viewer never matches the kossori author", () => {
  const { text, params } = render([dailyBestPerAuthor(undefined, true)]);
  assert.ok(text.includes("not best.kossori or false"), text);
  assert.equal(params.some((p) => String(p).startsWith("did:plc:s")), false);
});
