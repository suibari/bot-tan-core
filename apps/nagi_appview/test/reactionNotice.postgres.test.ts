import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての専用 DB でだけ走らせる。アプリの DB に対してフィクスチャを流さないこと。
//   NAGI_NOTICE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/nagi_notice_test
const testUrl = process.env.NAGI_NOTICE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_notice_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_notice_test";
}
process.env.NAGI_BOT_DID ??= "did:plc:testbot";
const database = await import("@bsky-affirmative-bot/database");
const { client, db } = database;
const { getTableConfig, PgTable } = await import("drizzle-orm/pg-core");
const { is } = await import("drizzle-orm");
const { insertReactionNotification, REACTION_GROUP_WINDOW_MS } = await import(
  "../src/ingest/reactionNotice.js"
);
const { getNotifications, getUnreadCount, updateSeen } = await import(
  "../src/queries/notifications.js"
);

const skip = testUrl ? false : "NAGI_NOTICE_TEST_DATABASE_URL が未設定";
const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';

before(async () => {
  if (!testUrl) return;
  // 実際の列型で全テーブルを作る（中身は空）。通知の一覧は投稿やミュートも引くため。
  for (const table of Object.values(database)) {
    if (!is(table, PgTable)) continue;
    const { schema = "public", name, columns } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(
      `create table if not exists ${quote(schema)}.${quote(name)} (${columns
        .map((c) => `${quote(c.name)} ${"enum" in c ? "text" : c.getSQLType()}`)
        .join(", ")})`,
    );
    await client.unsafe(`truncate ${quote(schema)}.${quote(name)}`);
  }
  await client`alter table nagi.notifications alter column id set default gen_random_uuid()`;
  await client`create unique index if not exists notice_reason on nagi.notifications (recipient_did, reason_uri)`;
  await client`create unique index if not exists notice_ledger_pk on nagi.reaction_notice_ledger (recipient_did, actor_did, subject_uri, emoji_key)`;
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.notifications, nagi.reaction_notice_ledger, nagi.reactions`;
});
after(() => client.end());

const me = "did:plc:me";
const alice = "did:plc:alice";
const bob = "did:plc:bob";
const postA = `at://${me}/com.suibari.nagi.post/a`;
const postB = `at://${me}/com.suibari.nagi.post/b`;
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 6, 10, 0) + minutes * 60_000);
let seq = 0;

/** リアクションを付ける。applyMutation と同じく reactions 行と通知を入れる。 */
async function react(actor: string, subject: string, emoji: string, minute: number) {
  const uri = `at://${actor}/com.suibari.nagi.reaction/${++seq}`;
  await client`insert into nagi.reactions (uri, cid, did, subject_uri, emoji, emoji_key, created_at)
    values (${uri}, 'cid', ${actor}, ${subject}, ${emoji}, ${emoji}, ${at(minute).toISOString()}::timestamptz)`;
  const result = await db.transaction((tx) =>
    insertReactionNotification(tx, {
      recipientDid: me,
      actorDid: actor,
      subjectUri: subject,
      reasonUri: uri,
      emojiKey: emoji,
      now: at(minute),
    }),
  );
  return { uri, pushed: Boolean(result.pushNotificationId) };
}
/** リアクションを外す。applyMutation の削除と同じく通知行も消す（台帳は残す）。 */
async function unreact(uri: string) {
  await client`delete from nagi.reactions where uri = ${uri}`;
  await client`delete from nagi.notifications where reason_uri = ${uri}`;
}
const emojis = (item: { reactions?: { emoji: string }[] }) =>
  item.reactions?.map((r) => r.emoji);

test("提案の表どおりに、まとめ・付け直し・Push が動く", { skip }, async () => {
  // 10:00 👍 → 1件目、Push あり
  const thumbs = await react(alice, postA, "👍", 0);
  assert.equal(thumbs.pushed, true);
  // 10:02 🎉 → 同じ通知にまとまる、Push なし
  assert.equal((await react(alice, postA, "🎉", 2)).pushed, false);
  assert.equal((await getUnreadCount(me)).count, 1);
  let list = await getNotifications(me, 50);
  assert.equal(list.items.length, 1);
  assert.deepEqual(emojis(list.items[0]!), ["👍", "🎉"]);
  assert.equal(list.items[0]!.reaction?.emoji, "🎉");

  // 10:03 👍 を外して付け直す → 変化なし
  await unreact(thumbs.uri);
  const thumbs2 = await react(alice, postA, "👍", 3);
  assert.equal(thumbs2.pushed, false);
  list = await getNotifications(me, 50);
  assert.equal(list.items.length, 1);
  assert.deepEqual(emojis(list.items[0]!), ["👍", "🎉"]);
  assert.equal(new Date(list.items[0]!.createdAt).getTime(), at(2).getTime());

  // 見たあとで、10:30 に 👍 を付け直す → 通知しない（既読のまま）
  await updateSeen(me, at(10));
  assert.equal((await getUnreadCount(me)).count, 0);
  await unreact(thumbs2.uri);
  assert.equal((await react(alice, postA, "👍", 30)).pushed, false);
  assert.equal((await getUnreadCount(me)).count, 0);
  list = await getNotifications(me, 50);
  assert.equal(list.items.length, 1);
  assert.ok(list.items[0]!.readAt);

  // 10:30 😂 → 5分を過ぎているので2件目、Push あり
  assert.equal((await react(alice, postA, "😂", 30)).pushed, true);
  assert.equal((await getUnreadCount(me)).count, 1);
  list = await getNotifications(me, 50);
  assert.deepEqual(list.items.map(emojis), [["😂"], ["👍", "🎉"]]);
});

test("まだ見ていない通知は、付け外しされても未読のまま", { skip }, async () => {
  const thumbs = await react(alice, postA, "👍", 0);
  await unreact(thumbs.uri);
  assert.equal((await getUnreadCount(me)).count, 0);
  // 付け直しても Push はしないが、本人が見ていないので未読に戻る。
  assert.equal((await react(alice, postA, "👍", 1)).pushed, false);
  assert.equal((await getUnreadCount(me)).count, 1);
  const list = await getNotifications(me, 50);
  assert.equal(list.items[0]!.readAt, null);
  // 見たあとは既読のまま戻る。
  await updateSeen(me, at(2));
  assert.equal((await getUnreadCount(me)).count, 0);
});

test("5分は最初の反応から数え、足すたびに延びない", { skip }, async () => {
  assert.equal((await react(alice, postA, "👍", 0)).pushed, true);
  assert.equal((await react(alice, postA, "🎉", 4)).pushed, false);
  // 最初から5分ちょうどで次のグループ。最後の反応(4分)からは1分しか経っていない。
  assert.equal(REACTION_GROUP_WINDOW_MS, 5 * 60_000);
  assert.equal((await react(alice, postA, "😂", 5)).pushed, true);
  const list = await getNotifications(me, 50);
  assert.deepEqual(list.items.map(emojis), [["😂"], ["👍", "🎉"]]);
});

test("まとめるのは同じ人・同じポストだけ", { skip }, async () => {
  assert.equal((await react(alice, postA, "👍", 0)).pushed, true);
  // 別のポストへの同じ絵文字は通知する
  assert.equal((await react(alice, postB, "👍", 1)).pushed, true);
  // 同じポストでも別の人なら別の通知
  assert.equal((await react(bob, postA, "👍", 1)).pushed, true);
  assert.equal((await getUnreadCount(me)).count, 3);
  assert.equal((await getNotifications(me, 50)).items.length, 3);
});

test("limit はまとめた後の件数で数える", { skip }, async () => {
  await react(alice, postA, "👍", 0);
  await react(alice, postA, "🎉", 1);
  await react(alice, postA, "😂", 2);
  await react(bob, postA, "👍", 3);
  const page = await getNotifications(me, 2);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map(emojis), [["👍"], ["👍", "🎉", "😂"]]);
  assert.equal(page.hasMore, true);
});

test("同じイベントの再処理では Push も行も増えない", { skip }, async () => {
  const first = await react(alice, postA, "👍", 0);
  const again = await db.transaction((tx) =>
    insertReactionNotification(tx, {
      recipientDid: me,
      actorDid: alice,
      subjectUri: postA,
      reasonUri: first.uri,
      emojiKey: "👍",
      now: at(1),
    }),
  );
  assert.equal(again.pushNotificationId, undefined);
  const [{ n }] = await client`select count(*)::int as n from nagi.notifications`;
  assert.equal(n, 1);
});
