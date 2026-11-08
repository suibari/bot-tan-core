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
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { getAdventCalendar, getAdventReadState, parseAdventReadInput, putAdventReadState } =
  await import("../src/queries/advent.js");

const skip = testUrl ? false : "NAGI_ADVENT_TEST_DATABASE_URL が未設定";
const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [
    database.nagiPosts,
    database.nagiActors,
    database.nagiProfiles,
    database.nagiAdventCards,
    database.nagiAdventReadStates,
  ]) {
    const { schema = "public", name, columns } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${columns
        .map((c) => `${quote(c.name)} ${"enum" in c ? "text" : c.getSQLType()}`)
        .join(", ")})`,
    );
  }
  await client`alter table nagi.advent_read_states add primary key (did, year)`;
  await client`alter table nagi.advent_read_states alter column opened_days set default '{}'`;
  await client`alter table nagi.advent_read_states alter column last_seen_day set default 0`;
  await client`alter table nagi.advent_read_states alter column updated_at set default now()`;
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.actors, nagi.profiles, nagi.advent_cards, nagi.advent_read_states`;
});
after(() => client.end());

async function card(day: number, did: string, postUri: string) {
  await client`insert into nagi.advent_cards (year, day, did, post_uri, post_cid, title_ja, title_en,
      comment_ja, comment_en, display_name, handle, avatar_cid, publish_at, created_at)
    values (2026, ${day}, ${did}, ${postUri}, 'cid', ${"見出し" + day}, 'title', '一言', 'comment',
      '控えの名前', 'old.test', 'oldcid', ${new Date(Date.UTC(2026, 11, day) - 9 * 3600_000).toISOString()}, now())`;
}

test("公開時刻前のカードは返さず、プロフィールは現在の値を優先する", { skip }, async () => {
  await client`insert into nagi.actors (did, handle, pds_url, status, resolved_at)
    values ('did:plc:a', 'new.test', 'x', 'active', now())`;
  await client`insert into nagi.profiles (did, display_name, avatar_cid, moderation_labels, created_at, indexed_at)
    values ('did:plc:a', '今の名前', 'newcid', '{}', now(), now())`;
  await client`insert into nagi.posts (uri, cid, rkey, did, text, moderation_labels, self_labels, kossori,
      record_created_at, indexed_at, quote_valid, appview_only, edited)
    values ('at://did:plc:a/p/1', 'cid', '1', 'did:plc:a', 't', '{}', '{}', false, now(), now(), false, false, false)`;
  await card(1, "did:plc:a", "at://did:plc:a/p/1");
  await card(2, "did:plc:gone", "at://did:plc:gone/p/1");
  await card(3, "did:plc:a", "at://did:plc:a/p/2");

  const view = await getAdventCalendar(2026, new Date("2026-12-01T16:00:00Z")); // 12/2 1:00 JST
  assert.equal(view.openedDay, 2);
  assert.equal(view.nextOpenAt, "2026-12-02T15:00:00.000Z");
  assert.deepEqual(view.cards.map((c) => c.day), [1, 2]);
  assert.equal(view.cards[0].actor.displayName, "今の名前");
  assert.equal(view.cards[0].actor.avatar, "/api/blob/did%3Aplc%3Aa/newcid");
  assert.equal(view.cards[0].postUri, "at://did:plc:a/p/1");
  // 本人のプロフィールもポストも消えていても、控えでカードを残す。
  assert.equal(view.cards[1].actor.displayName, "控えの名前");
  assert.equal(view.cards[1].actor.handle, "old.test");
  assert.equal(view.cards[1].postUri, undefined);
});

test("既読は前にしか進まず、開封済みの日は足すだけ", { skip }, async () => {
  const now = new Date("2026-12-05T00:00:00Z");
  const put = (input: unknown) => putAdventReadState("did:plc:a", parseAdventReadInput(input, now)!);
  await put({ year: 2026, lastSeenDay: 4 });
  await put({ year: 2026, lastSeenDay: 2, openedDay: 3 });
  await put({ year: 2026, openedDay: 1 });
  await put({ year: 2026, openedDay: 3 });
  const state = await getAdventReadState("did:plc:a", now);
  assert.deepEqual(state, { year: 2026, lastSeenDay: 4, openedDays: [1, 3] });
  assert.throws(() => parseAdventReadInput({ year: 2026, lastSeenDay: 6 }, now));
  assert.throws(() => parseAdventReadInput({ year: 2025, lastSeenDay: 1 }, now));
});
