import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

// 使い捨ての専用 DB でだけ走らせる（作り方は nagi_appview/test/recommended.postgres.test.ts）。
//   NAGI_RECOMMENDED_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/nagi_recommended_test
const testUrl = process.env.NAGI_RECOMMENDED_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_recommended_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_recommended_test";
}
const { client } = await import("@bsky-affirmative-bot/database");
const { pruneInterestProbes, saveBlueskyInterestProbes, selectProbeTexts } = await import(
  "../src/interestProbes.js"
);

const skip = testUrl ? false : "NAGI_RECOMMENDED_TEST_DATABASE_URL が未設定";

const vec = (i: number) => Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0));
const feed = (text: string, opts: { reply?: boolean; repost?: boolean } = {}) =>
  ({
    post: { record: { text, ...(opts.reply ? { reply: {} } : {}) } },
    ...(opts.repost ? { reason: { $type: "app.bsky.feed.defs#reasonRepost" } } : {}),
  }) as any;

beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.actor_interest_probes`;
});
after(() => client.end());

test("材料は返信・リポスト・空の投稿を除いた新しい順の10件", () => {
  const feeds = [
    feed("返信", { reply: true }),
    feed("リポスト", { repost: true }),
    feed("  "),
    ...Array.from({ length: 12 }, (_, i) => feed(`投稿${i}`)),
  ];
  assert.deepEqual(
    selectProbeTexts(feeds),
    Array.from({ length: 10 }, (_, i) => `投稿${i}`),
  );
});

test("埋め込めた分だけを保存し、前の材料は置き換える", { skip }, async () => {
  await saveBlueskyInterestProbes("did:plc:a", ["古い"], async () => [vec(9)]);
  const saved = await saveBlueskyInterestProbes("did:plc:a", ["一", "二", "三"], async () => [
    vec(0),
    null,
    vec(2),
  ]);
  assert.equal(saved, 2);
  const rows = await client`select position from nagi.actor_interest_probes where did = 'did:plc:a' order by position`;
  assert.deepEqual(rows.map((row) => row.position), [0, 1]);
});

test("Nagi の埋め込み済み投稿が5件以上になった人の材料だけを消す", { skip }, async () => {
  for (const did of ["did:plc:enough", "did:plc:few"])
    await saveBlueskyInterestProbes(did, ["本文"], async () => [vec(0)]);
  const posts = [
    ...Array.from({ length: 5 }, () => "did:plc:enough"),
    ...Array.from({ length: 4 }, () => "did:plc:few"),
  ];
  for (const [i, did] of posts.entries())
    await client`insert into nagi.posts (uri, cid, rkey, did, text, record_created_at, embedding)
      values (${`at://${did}/p/${i}`}, 'cid', ${String(i)}, ${did}, 't', now(), ${`[${vec(1).join(",")}]`}::vector)`;

  assert.equal(await pruneInterestProbes(), 1);
  const rows = await client`select distinct did from nagi.actor_interest_probes`;
  assert.deepEqual(rows.map((row) => row.did), ["did:plc:few"]);
});
