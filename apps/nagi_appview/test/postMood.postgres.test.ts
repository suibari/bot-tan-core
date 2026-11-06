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
const { POST_MOOD_VERSION } = await import("@bsky-affirmative-bot/shared-configs");
const { loadDiaryMoods, setPostMood } = await import("../src/queries/diaries.js");

const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [database.nagiPosts, database.nagiPostMoods, database.nagiDiaries]) {
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
  await client`truncate nagi.posts, nagi.post_moods, nagi.diaries`;
});
after(() => client.end());

const alice = "did:plc:alice";
const bob = "did:plc:bob";
const uri = (did: string, key: string) => `at://${did}/com.suibari.nagi.post/${key}`;
async function post(did: string, key: string, createdAt = "2026-08-01T03:00:00Z") {
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_created_at, indexed_at,
     moderation_labels, self_labels, moderation_version, kossori, record_json, langs)
    values (${uri(did, key)}, 'cid1', ${key}, ${did}, ${`text ${key}`}, ${createdAt}, ${createdAt},
      '{}', '{}', 'legacy', false, '{}', '["ja"]')`;
}
async function mood(
  did: string,
  key: string,
  values: { valence: number | null; expressive: boolean; version?: string; cid?: string },
) {
  await client`insert into nagi.post_moods (post_uri, did, cid, valence, expressive, version, scored_at)
    values (${uri(did, key)}, ${did}, ${values.cid ?? "cid1"}, ${values.valence}, ${values.expressive},
      ${values.version ?? POST_MOOD_VERSION}, now())`;
}
const range = () => loadDiaryMoods(alice, "2026-08-01", "2026-08-01");

test("直した値がグラフに出て、edited が付き、戻すと LLM の値に戻る", { skip: !testUrl }, async () => {
  await post(alice, "a");
  await mood(alice, "a", { valence: 3, expressive: true });

  const edited = await setPostMood(alice, { uri: uri(alice, "a"), valence: -2 });
  assert.equal(edited.mood?.valence, -2);
  assert.equal(edited.mood?.edited, true);
  assert.equal(edited.mood?.date, "2026-08-01");
  const loaded = await range();
  assert.deepEqual(
    loaded.moods.map((m) => [m.valence, m.edited]),
    [[-2, true]],
  );

  const reverted = await setPostMood(alice, { uri: uri(alice, "a") });
  assert.equal(reverted.mood?.valence, 3);
  assert.equal(reverted.mood?.edited, undefined);
  const [row] = await client`select user_valence, user_edited_at from nagi.post_moods`;
  assert.equal(row.user_valence, null);
  assert.equal(row.user_edited_at, null);
});

test("版上げの採点し直し待ちでも、直した点は出し続ける", { skip: !testUrl }, async () => {
  await post(alice, "a");
  await post(alice, "b");
  await mood(alice, "a", { valence: 3, expressive: true });
  await mood(alice, "b", { valence: 2, expressive: true });
  await setPostMood(alice, { uri: uri(alice, "a"), valence: 5 });
  await client`update nagi.post_moods set version = 'old'`;

  const loaded = await range();
  assert.deepEqual(loaded.moods.map((m) => m.valence), [5]);
  assert.equal(loaded.moodPending, 1);
});

test("他人の投稿・中立・不正な値は直せない", { skip: !testUrl }, async () => {
  await post(alice, "a");
  await post(alice, "neutral");
  await post(bob, "b");
  await mood(alice, "a", { valence: 3, expressive: true });
  await mood(alice, "neutral", { valence: 0, expressive: false });
  await mood(bob, "b", { valence: 3, expressive: true });

  const status = async (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: { status?: number }) => error.status,
    );
  assert.equal(await status(setPostMood(alice, { uri: uri(bob, "b"), valence: 1 })), 404);
  assert.equal(await status(setPostMood(alice, { uri: uri(alice, "neutral"), valence: 1 })), 404);
  for (const valence of [0, 6, -6, 1.5, "2"])
    assert.equal(await status(setPostMood(alice, { uri: uri(alice, "a"), valence })), 400);
  const rows = await client`select user_valence from nagi.post_moods where user_valence is not null`;
  assert.equal(rows.length, 0);
});

test("投稿が編集されて cid が変わった後の古い修正は出さない", { skip: !testUrl }, async () => {
  await post(alice, "a");
  await mood(alice, "a", { valence: 3, expressive: true });
  await setPostMood(alice, { uri: uri(alice, "a"), valence: -4 });
  await client`update nagi.posts set cid = 'cid2'`;

  const loaded = await range();
  assert.equal(loaded.moods.length, 0);
  assert.equal(loaded.moodPending, 1);
});
