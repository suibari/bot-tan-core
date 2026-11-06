import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての DB 専用。アプリの DB に対してフィクスチャを流さない。
const testUrl = process.env.NAGI_MOOD_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_mood_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_mood_test";
}
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { storePostMood } = await import("../src/NagiPostMoodWorker.js");

const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [database.nagiPosts, database.nagiPostMoods]) {
    const { schema = "public", name, columns } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${columns
        .map(
          (column) =>
            `${quote(column.name)} ${"enum" in column ? "text" : column.getSQLType()}${column.primary ? " primary key" : ""}`,
        )
        .join(", ")})`,
    );
  }
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.post_moods`;
});
after(() => client.end());

const did = "did:plc:alice";
const uri = `at://${did}/com.suibari.nagi.post/a`;
async function post(cid: string) {
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_created_at, indexed_at,
     moderation_labels, self_labels, moderation_version, kossori, record_json)
    values (${uri}, ${cid}, 'a', ${did}, 'text', now(), now(), '{}', '{}', 'legacy', false, '{}')
    on conflict (uri) do update set cid = excluded.cid`;
}

test("採点し直しでも同じ cid なら本人の修正を残し、編集後は消す", { skip: !testUrl }, async () => {
  await post("cid1");
  assert.equal(await storePostMood({ uri, did, cid: "cid1", text: "text" }, { valence: 3, expressive: true }), true);
  await client`update nagi.post_moods set user_valence = -2, user_edited_at = now()`;

  // 版上げの採点し直し（cid は同じ）。
  await storePostMood({ uri, did, cid: "cid1", text: "text" }, { valence: 1, expressive: true });
  let [row] = await client`select valence, user_valence, user_edited_at from nagi.post_moods`;
  assert.equal(row.valence, 1);
  assert.equal(row.user_valence, -2);
  assert.notEqual(row.user_edited_at, null);

  // 投稿が編集された。
  await post("cid2");
  await storePostMood({ uri, did, cid: "cid2", text: "text2" }, { valence: 4, expressive: true });
  [row] = await client`select valence, cid, user_valence, user_edited_at from nagi.post_moods`;
  assert.equal(row.valence, 4);
  assert.equal(row.cid, "cid2");
  assert.equal(row.user_valence, null);
  assert.equal(row.user_edited_at, null);
});
