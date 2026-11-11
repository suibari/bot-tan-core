import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての専用 DB でだけ走らせる。アプリの DB に対してフィクスチャを流さないこと。
//   NAGI_ADVENT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/nagi_advent_test
const testUrl = process.env.NAGI_ADVENT_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_advent_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_advent_test";
}
process.env.NAGI_BOT_DID = "did:plc:bot";
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { loadAdventCandidates } = await import("../src/NagiAdventFeature.js");

const skip = testUrl ? false : "NAGI_ADVENT_TEST_DATABASE_URL が未設定";
const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
const tables = [
  database.nagiPosts,
  database.nagiPostMoods,
  database.nagiActors,
  database.nagiProfiles,
  database.nagiAdventCards,
  database.nagiAdventRejections,
];

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of tables) {
    const { schema = "public", name, columns } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${columns
        .map((c) => `${quote(c.name)} ${"enum" in c ? "text" : c.getSQLType()}`)
        .join(", ")})`,
    );
  }
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.post_moods, nagi.actors, nagi.profiles, nagi.advent_cards, nagi.advent_rejections`;
});
after(() => client.end());

async function actor(did: string, joinedAt = "2026-08-01T00:00:00Z", profileLabels: string[] = []) {
  await client`insert into nagi.actors (did, handle, pds_url, status, resolved_at)
    values (${did}, ${did.slice(8) + ".test"}, 'https://pds', 'active', now())`;
  await client`insert into nagi.profiles (did, display_name, moderation_labels, created_at, indexed_at)
    values (${did}, ${did.slice(8)}, ${profileLabels}, ${joinedAt}, now())`;
}

let seq = 0;
async function post(
  did: string,
  input: {
    text?: string;
    valence?: number;
    userValence?: number;
    expressive?: boolean;
    kossori?: boolean;
    root?: string;
    parent?: string;
    labels?: string[];
    selfLabels?: string[];
    moderationVersion?: string | null;
    article?: boolean;
    at?: string;
    deleted?: boolean;
  } = {},
) {
  seq += 1;
  const uri = `at://${did}/com.suibari.nagi.post/${seq}`;
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_json, moderation_labels, moderation_version, self_labels,
     reply_root_uri, reply_parent_uri, kossori, record_created_at, indexed_at, deleted_at,
     quote_valid, appview_only, edited)
    values (${uri}, 'cid', ${String(seq)}, ${did}, ${input.text ?? "今日はじめてパンを焼いたらふわふわにできた！"},
      ${JSON.stringify(input.article ? { article: true } : {})}::jsonb, ${input.labels ?? []},
      ${input.moderationVersion === undefined ? "v1" : input.moderationVersion},
      ${input.selfLabels ?? []}, ${input.root ?? null}, ${input.parent ?? null}, ${input.kossori ?? false},
      ${input.at ?? "2026-09-01T00:00:00Z"}, now(), ${input.deleted ? new Date().toISOString() : null},
      false, false, false)`;
  await client`insert into nagi.post_moods (post_uri, did, cid, valence, expressive, version, scored_at, user_valence)
    values (${uri}, ${did}, 'cid', ${input.valence ?? 4}, ${input.expressive ?? true}, 'v', now(), ${input.userValence ?? null})`;
  return uri;
}

const uris = async (minValence = 3) =>
  (await loadAdventCandidates({ year: 2026, day: 1, minValence }))
    .flatMap((user) => user.posts.map((p) => p.uri))
    .sort();

test("除外条件に当たるポストは候補にしない", { skip }, async () => {
  await actor("did:plc:alice");
  await actor("did:plc:labeled", undefined, ["sexual"]);
  await actor("did:plc:bot");
  const ok = await post("did:plc:alice");
  await post("did:plc:alice", { valence: 2 });
  await post("did:plc:alice", { expressive: false });
  await post("did:plc:alice", { kossori: true });
  await post("did:plc:alice", { labels: ["graphic"] });
  await post("did:plc:alice", { selfLabels: ["nudity"] });
  await post("did:plc:alice", { moderationVersion: null });
  await post("did:plc:alice", { text: "||ネタバレ||映画が最高だった！楽しかった" });
  await post("did:plc:alice", { text: "おはよう" });
  await post("did:plc:alice", { article: true });
  await post("did:plc:alice", { at: "2026-06-30T00:00:00Z" });
  // 12/1 の選出時刻（11/30 23:00 JST）より後。
  await post("did:plc:alice", { at: "2026-11-30T14:30:00Z" });
  await post("did:plc:alice", { deleted: true });
  await post("did:plc:labeled");
  await post("did:plc:bot");
  assert.deepEqual(await uris(), [ok]);
});

test("本人が直した気分を優先する", { skip }, async () => {
  await actor("did:plc:alice");
  const raised = await post("did:plc:alice", { valence: 1, userValence: 4 });
  await post("did:plc:alice", { valence: 5, userValence: -2 });
  assert.deepEqual(await uris(), [raised]);
});

test("返信は自分のスレッドの続きだけ。こっそりスレッドは除く", { skip }, async () => {
  await actor("did:plc:alice");
  await actor("did:plc:bob");
  const root = await post("did:plc:alice", { valence: 0 });
  const own = await post("did:plc:alice", { root, parent: root });
  await post("did:plc:bob", { root, parent: root });
  const secret = await post("did:plc:alice", { kossori: true, valence: 0 });
  await post("did:plc:alice", { root: secret, parent: secret });
  assert.deepEqual(await uris(), [own]);
});

test("1人3件まで。選出済みと12月の新規を印付けし、使ったポストは除く", { skip }, async () => {
  await actor("did:plc:alice");
  await actor("did:plc:newbie", "2026-12-01T00:00:00Z");
  for (let i = 0; i < 5; i += 1) await post("did:plc:alice", { valence: 3 + (i % 3) });
  const used = await post("did:plc:newbie", { valence: 5 });
  await post("did:plc:newbie");
  await client`insert into nagi.advent_cards (year, day, did, post_uri, post_cid, title_ja, title_en,
      comment_ja, comment_en, display_name, handle, publish_at, created_at)
    values (2026, 1, 'did:plc:newbie', ${used}, 'cid', 't', 't', 'c', 'c', 'n', 'n', now(), now())`;
  const users = await loadAdventCandidates({ year: 2026, day: 2, minValence: 3 });
  const alice = users.find((u) => u.did === "did:plc:alice")!;
  const newbie = users.find((u) => u.did === "did:plc:newbie")!;
  assert.equal(alice.posts.length, 3);
  assert.equal(alice.picked, false);
  assert.equal(newbie.picked, true);
  assert.equal(newbie.joinedThisMonth, true);
  assert.equal(newbie.posts.length, 1);
  assert.notEqual(newbie.posts[0].uri, used);
});

test("その年に不採用になったポストは除く（前の年の不採用は関係ない）", { skip }, async () => {
  await actor("did:plc:alice");
  const rejected = await post("did:plc:alice");
  const lastYear = await post("did:plc:alice");
  await client`insert into nagi.advent_rejections (year, post_uri, created_at)
    values (2026, ${rejected}, now()), (2025, ${lastYear}, now())`;
  assert.deepEqual(await uris(), [lastYear]);
});

test("その日すでに見せたポストは除ける", { skip }, async () => {
  await actor("did:plc:alice");
  const a = await post("did:plc:alice");
  const b = await post("did:plc:alice");
  const users = await loadAdventCandidates({ year: 2026, day: 1, minValence: 3, excludeUris: [a] });
  assert.deepEqual(users.flatMap((u) => u.posts.map((p) => p.uri)), [b]);
});
