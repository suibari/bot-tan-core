import assert from "node:assert/strict";
import test from "node:test";
import type { MuteSet } from "../src/queries/mutes.js";
// db.ts が接続文字列を要求するので、import より先にダミーを入れておく（実際には接続しない。
// toSQL() は SQL を組み立てるだけでクエリを発行しない）。
process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { db, nagiPosts } = await import("@bsky-affirmative-bot/database");
const { and, sql } = await import("drizzle-orm");
const { muteVisibility, sibNotMuted } = await import("../src/queries/mutes.js");

type Rendered = { text: string; params: unknown[] };
const render = (conditions: unknown[]): Rendered => {
  const query = db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(and(...(conditions as any[])));
  const { sql: text, params } = query.toSQL();
  return { text: text.replace(/\s+/g, " "), params };
};

const mutes = (actors: string[], tags: string[] = []): MuteSet => ({
  actors,
  tags,
});

test("no mutes produces no extra conditions", () => {
  assert.deepEqual(
    muteVisibility(mutes([], []), { actors: true, tags: true }),
    [],
  );
  assert.equal(sibNotMuted(mutes([]), true).queryChunks.length, 0);
});

test("apply flags gate each mute kind independently", () => {
  const set = mutes(["did:plc:a"], ["foo"]);
  // プロフィールフィードは両方適用外。
  assert.deepEqual(muteVisibility(set, { actors: false, tags: false }), []);
  const actorsOnly = render(muteVisibility(set, { actors: true, tags: false }));
  assert.ok(!actorsOnly.text.includes('"tags"'));
  assert.ok(actorsOnly.text.includes('"did" not in'));
});

test("tag timeline does not hide the tag it was opened for", () => {
  // #foo のページで #foo のミュートまで効かせると、そのページが空になる。
  assert.deepEqual(
    muteVisibility(mutes([], ["foo"]), {
      actors: true,
      tags: true,
      exceptTag: "foo",
    }),
    [],
  );
  const { params } = render(
    muteVisibility(mutes([], ["foo", "bar"]), {
      actors: true,
      tags: true,
      exceptTag: "foo",
    }),
  );
  assert.deepEqual(params.filter((p) => Array.isArray(p)), [["bar"], ["bar"]]);
});

test("muted actors bind as a single text[] parameter, not a row constructor", () => {
  // ここが壊れると ($1, $2)::text[] になり、ミュート2件目から実行時エラーになる。
  // 1件のときだけ偶然通ってしまうので、複数件で検証する。
  const set = mutes(["did:plc:aaa", "did:plc:bbb"]);
  const { text, params } = render(
    muteVisibility(set, { actors: true, tags: false }),
  );
  assert.ok(
    text.includes("<> all($"),
    `expected an array comparison, got: ${text}`,
  );
  assert.ok(
    !/all\(\(\$\d+, \$\d+\)/.test(text),
    `muted actors were expanded into a row constructor: ${text}`,
  );
  const arrayParams = params.filter((p) => Array.isArray(p));
  assert.equal(arrayParams.length, 1);
  assert.deepEqual(arrayParams[0], ["did:plc:aaa", "did:plc:bbb"]);
});

test("thread root author mute hides the whole conversation", () => {
  const { text } = render(
    muteVisibility(mutes(["did:plc:aaa"]), { actors: true, tags: false }),
  );
  // ルートを引く相関サブクエリがあり、解決できない返信は false 側（非表示）に倒れること。
  assert.ok(text.includes("nagi.posts as thread_root"));
  assert.ok(text.includes("thread_root.did <> all("));
  assert.ok(text.includes("), false)"));
});

test("tag mute keeps posts that have no tags and no channel", () => {
  const { text } = render(
    muteVisibility(mutes([], ["foo"]), { actors: false, tags: true }),
  );
  // tags / channel_uri が NULL の投稿で条件が NULL になると、タグ無し投稿が全部消える。
  // NULL を false に畳んでから否定していることを確かめる。
  assert.ok(text.includes("not coalesce(("), text);
  assert.ok(text.includes(", false)"));
});

test("tag mute also hides legacy channel posts by channel name", () => {
  const { text } = render(
    muteVisibility(mutes([], ["foo"]), { actors: false, tags: true }),
  );
  assert.ok(text.includes('"tags" && $'));
  assert.ok(text.includes('"channel_uri" = any(array( select channel.uri from nagi.channels'));
});

test("sib filter is added only when actor mutes apply", () => {
  const set = mutes(["did:plc:aaa", "did:plc:bbb"]);
  assert.equal(sibNotMuted(set, false).queryChunks.length, 0);
  const { text, params } = render([
    sql`not exists (select 1 from nagi.posts as sib where sib.deleted_at is null${sibNotMuted(set, true)})`,
  ]);
  assert.ok(text.includes("sib.did <> all($"));
  assert.deepEqual(
    params.filter((p) => Array.isArray(p))[0],
    ["did:plc:aaa", "did:plc:bbb"],
  );
});
