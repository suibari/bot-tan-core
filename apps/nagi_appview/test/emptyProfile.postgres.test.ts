import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// Dedicated disposable database only; never run fixtures against the app database.
const testUrl = process.env.NAGI_PROFILE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_profile_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_profile_test";
}
process.env.NAGI_BOT_DID ??= "did:plc:testbot";
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { searchActors } = await import("../src/queries/actors.js");
const { getActorProfile } = await import("../src/queries/profile.js");
const { fetchPostRows, hydratePostViews } = await import("../src/queries/timeline.js");

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  // Use real column types for all queries, with empty unrelated feature tables.
  for (const table of [
    database.nagiActors, database.nagiProfiles, database.nagiPosts,
    database.nagiPostScores, database.nagiActorAnalyses,
    database.nagiActorInterestKeywords, database.nagiAgeAssurance,
    database.nagiZenkatsuTrophies, database.followers,
    database.nagiReactions, database.nagiEmojis,
  ]) {
    const { schema = "public", name, columns } = getTableConfig(table);
    const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(
      `create table if not exists ${quote(schema)}.${quote(name)} (${columns
        .map((column) => `${quote(column.name)} ${"enum" in column ? "text" : column.getSQLType()}`)
        .join(", ")})`,
    );
    await client.unsafe(`truncate ${quote(schema)}.${quote(name)}`);
  }
});
after(() => client.end());

const did = (name: string) => `did:plc:${name}`;
const uri = (name: string, key = "one") => `at://${did(name)}/com.suibari.nagi.post/${key}`;
async function actor(name: string, status = "active") {
  await client`insert into nagi.actors (did, handle, pds_url, status)
    values (${did(name)}, ${`zz-${name}.test`}, 'https://pds.example', ${status})`;
}
async function post(name: string, key = "one", deleted = false) {
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_created_at, indexed_at, deleted_at,
     moderation_labels, self_labels, moderation_version, kossori, record_json)
    values (${uri(name, key)}, 'testcid', ${key}, ${did(name)}, 'hello',
      '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z',
      ${deleted ? "2026-01-03T00:00:00Z" : null}::timestamptz,
      '{}', '{}', 'legacy', false, '{}')`;
}
async function profile(name: string, displayName = "Nagi name") {
  await client`insert into nagi.profiles (did, display_name, description, avatar_cid, created_at)
    values (${did(name)}, ${displayName}, 'Nagi bio', 'avatarcid', '2026-02-01T00:00:00Z')`;
}
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

test("search includes profileless authors once and excludes cache-only, deleted-only and inactive actors", { skip: !testUrl }, async () => {
  for (const name of ["author", "profile", "cache", "deleted", "inactive"]) {
    await actor(name, name === "inactive" ? "deactivated" : "active");
  }
  await post("author");
  await post("author", "two");
  await profile("profile");
  await post("deleted", "one", true);
  await post("inactive");
  // Two characters deliberately avoid calling an external embedding service.
  for (const mode of ["exact", "hybrid"] as const) {
    const result = await searchActors("zz", 20, mode);
    assert.deepEqual(result.actors.map((a) => a.did), [did("author"), did("profile")]);
    assert.deepEqual(wire(result.actors[0]), { did: did("author"), handle: "zz-author.test" });
    assert.equal(result.actors[1].displayName, "Nagi name");
    assert.equal(result.actors[1].avatar, `/api/blob/${encodeURIComponent(did("profile"))}/avatarcid`);
    assert.equal((await searchActors("zz", 1, mode)).actors.length, 1);
  }
  assert.equal((await searchActors("Nagi name", 20, "exact")).actors[0].did, did("profile"));
});

test("profileless posts and profiles survive profile creation, deletion and recreation", { skip: !testUrl }, async () => {
  const name = "lifecycle";
  await post(name);
  const readPost = async () => {
    const views = await hydratePostViews(await fetchPostRows([uri(name)]));
    assert.equal(views.length, 1);
    assert.equal(views[0].text, "hello");
    return views[0].author;
  };
  const detail = await getActorProfile(did(name));
  assert.equal(detail.handle, did(name));
  assert.equal(detail.postCount, 1);
  assert.equal(detail.joinedAt, "2026-01-02T00:00:00.000Z");
  assert.equal((await readPost()).handle, did(name));
  await actor(name);
  for (const view of [await getActorProfile(did(name)), await readPost()]) {
    assert.equal(view.handle, "zz-lifecycle.test");
    for (const field of ["displayName", "description", "avatar"]) {
      assert.equal(field in wire(view), false);
    }
  }
  await profile(name, "First name");
  assert.equal((await readPost()).displayName, "First name");
  assert.equal((await getActorProfile(did(name))).joinedAt, "2026-02-01T00:00:00.000Z");
  // This is the same profile-row deletion performed by applyMutation.
  await client`delete from nagi.profiles where did = ${did(name)}`;
  for (const view of [await getActorProfile(did(name)), await readPost()]) {
    for (const field of ["displayName", "description", "avatar"]) {
      assert.equal(field in wire(view), false);
    }
  }
  assert.equal((await searchActors("zz-lifecycle", 20, "exact")).actors.length, 1);
  await profile(name, "New name");
  assert.equal((await getActorProfile(did(name))).displayName, "New name");
  assert.equal((await readPost()).displayName, "New name");
  assert.equal((await searchActors("zz-lifecycle", 20, "exact")).actors[0].displayName, "New name");
});
