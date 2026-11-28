import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての専用 DB でだけ走らせる。アプリの DB に対してフィクスチャを流さないこと。
//   NAGI_PRIVATE_SPACE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/nagi_private_space_test
const testUrl = process.env.NAGI_PRIVATE_SPACE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_private_space_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_private_space_test";
}
process.env.NAGI_BOT_DID ??= "did:plc:testbot";
process.env.NAGI_PRIVATE_SPACE_ENABLED = "true";

const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { NAGI_PRIVATE, nagiPrivateSpaceUri } = await import(
  "@bsky-affirmative-bot/nagi-lexicon"
);
const { ApiError } = await import("../src/middleware/errors.js");
const storage = await import("../src/privateSpace/storage.js");
const { setMute } = await import("../src/queries/mutes.js");
const { putDraft } = await import("../src/queries/drafts.js");
const { putPreferences } = await import("../src/queries/preferences.js");

const skip = testUrl ? false : "NAGI_PRIVATE_SPACE_TEST_DATABASE_URL が未設定";
const OWNER = "did:plc:private-space-owner";
const status = (code: number) => (error: unknown) =>
  error instanceof ApiError && error.status === code;

before(async () => {
  if (!testUrl) return;
  await client`create schema if not exists nagi`;
  await client`drop table if exists nagi.private_spaces, nagi.mutes, nagi.drafts`;
  // 書き出しが読むだけのテーブル。列だけあればよい。
  for (const table of [
    database.nagiPrivateListMembers,
    database.nagiBookmarkFolders,
    database.nagiBookmarks,
    database.nagiLanguagePreferences,
    database.nagiModerationPreferences,
    database.nagiNotificationPreferences,
    database.nagiBookmarkPreferences,
    database.nagiDiaryDayPreferences,
    database.nagiEmojiFavorites,
    database.nagiTagFavorites,
    database.nagiFeedTabs,
  ]) {
    const { name, columns } = getTableConfig(table);
    await client.unsafe(`drop table if exists nagi."${name}"`);
    await client.unsafe(
      `create table nagi."${name}" (${columns
        .map((c) => `"${c.name}" ${c.getSQLType()}`)
        .join(", ")})`,
    );
  }
  await client.unsafe(
    readFileSync(
      new URL(
        "../../../packages/database/drizzle/0108_nagi_private_spaces.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await client`create table nagi.mutes (
    muter_did text not null, subject_type text not null, subject text not null,
    created_at timestamptz not null default now(),
    primary key (muter_did, subject_type, subject))`;
  await client`create table nagi.drafts (
    id uuid primary key, owner_did text not null, content jsonb not null,
    created_at timestamptz not null, updated_at timestamptz not null)`;
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.private_spaces, nagi.mutes, nagi.drafts`;
});
after(() => client.end());

test("移行の開始・書き出し・中断で保存先と門番が切り替わる", { skip }, async () => {
  assert.equal((await storage.getPrivateSpaceStatus(OWNER)).storage, "appview");
  await setMute(OWNER, "actor", "did:plc:noisy", true);

  // 書き出しは移行中だけ。
  await assert.rejects(storage.exportPrivateData(OWNER), status(409));

  const space = nagiPrivateSpaceUri(OWNER);
  const begun = await storage.beginPrivateSpaceMigration(OWNER, space);
  assert.equal(begun.storage, "migrating");
  assert.equal(begun.space, space);
  // 途中で閉じたタブからの再開は同じ状態を返す。
  assert.equal((await storage.beginPrivateSpaceMigration(OWNER, space)).storage, "migrating");

  const { records } = await storage.exportPrivateData(OWNER);
  assert.deepEqual(
    records.map((record) => [record.collection, record.value.subject]),
    [[NAGI_PRIVATE.mute, "did:plc:noisy"]],
  );

  // 移行中は従来の書き込みを止める。移らない項目（既読位置など）だけなら通す。
  await assert.rejects(setMute(OWNER, "actor", "did:plc:other", true), status(423));
  const now = new Date().toISOString();
  await assert.rejects(
    putDraft(OWNER, {
      id: crypto.randomUUID(),
      content: { text: "x", mentions: [], emojis: [], linkCards: [], dismissedUrls: [] },
      createdAt: now,
      updatedAt: now,
    }),
    status(423),
  );
  await assert.rejects(
    putPreferences(OWNER, { tagFavorites: ["x"], tagFavoritesUpdatedAt: now }),
    status(423),
  );

  // 移行後に相当する状態では 409。
  await client`update nagi.private_spaces set storage = 'space' where did = ${OWNER}`;
  await assert.rejects(setMute(OWNER, "actor", "did:plc:other", true), status(409));
  await assert.rejects(storage.beginPrivateSpaceMigration(OWNER, space), status(409));

  // 戻すと AppView に書ける。space の URI は次回のために残す。
  const aborted = await storage.abortPrivateSpaceMigration(OWNER);
  assert.equal(aborted.storage, "appview");
  assert.equal(aborted.space, space);
  await setMute(OWNER, "actor", "did:plc:other", true);
  const [{ count }] = await client`select count(*)::int as count from nagi.mutes where muter_did = ${OWNER}`;
  assert.equal(count, 2);
});

test("他人の space を自分の移行先として登録させない", { skip }, async () => {
  await assert.rejects(
    storage.beginPrivateSpaceMigration(OWNER, nagiPrivateSpaceUri("did:plc:someone-else")),
    status(400),
  );
  await assert.rejects(
    storage.beginPrivateSpaceMigration(OWNER, `at:space/${OWNER}/com.example.other/self`),
    status(400),
  );
  assert.equal((await storage.getPrivateSpaceStatus(OWNER)).storage, "appview");
});
