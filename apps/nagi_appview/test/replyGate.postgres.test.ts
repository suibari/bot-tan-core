import assert from "node:assert/strict";
import { after, test } from "node:test";

// Dedicated disposable database only; never run fixtures against the app database.
const testUrl = process.env.NAGI_REPLY_GATE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_reply_gate_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL =
    "postgres://user:pass@localhost:5432/nagi_reply_gate_test";
}
process.env.NAGI_BOT_DID = "did:plc:replygatebot";
const { client } = await import("@bsky-affirmative-bot/database");
const { applyMutation } = await import("../src/ingest/applyMutation.js");
const { createKossoriPost } = await import("../src/queries/kossoriPosts.js");
const { fetchPostRows, hydratePostViews } = await import(
  "../src/queries/timeline.js"
);

after(() => client.end());

const BOT = "did:plc:replygatebot";
const run = `${Date.now()}`;
const did = (name: string) => `did:plc:rg${name}${run}`;
const uriOf = (author: string, rkey: string) =>
  `at://${author}/com.suibari.nagi.post/${rkey}`;
let seq = 0;

async function put(
  author: string,
  rkey: string,
  extra: Record<string, unknown> = {},
) {
  seq += 1;
  await applyMutation({
    did: author,
    time_us: Date.now() * 1000 + seq,
    commit: {
      operation: "create",
      collection: "com.suibari.nagi.post",
      rkey,
      cid: `bafyreplygate${run}${seq}`,
      record: {
        $type: "com.suibari.nagi.post",
        text: "hello",
        createdAt: new Date().toISOString(),
        ...extra,
      },
    },
  });
}
const replyTo = (parentUri: string) => ({
  reply: {
    root: { uri: parentUri, cid: "bafyparent" },
    parent: { uri: parentUri, cid: "bafyparent" },
  },
});
async function visible(uri: string) {
  const [row] = await client`select deleted_at from nagi.posts where uri = ${uri}`;
  return Boolean(row) && row.deleted_at === null;
}
async function replyNotifications(uri: string) {
  const rows =
    await client`select id from nagi.notifications where reason_uri = ${uri}`;
  return rows.length;
}

test("nobody: 本人以外の返信は取り込まず通知もしない", { skip: !testUrl }, async () => {
  const author = did("a1");
  const other = did("o1");
  const parent = uriOf(author, "p");
  await put(author, "p", { replyGate: "nobody", botSilent: true });
  await put(other, "r", replyTo(parent));
  await put(BOT, "b", replyTo(parent));
  await put(author, "self", replyTo(parent));
  assert.equal(await visible(uriOf(other, "r")), false);
  assert.equal(await replyNotifications(uriOf(other, "r")), 0);
  assert.equal(await visible(uriOf(BOT, "b")), false);
  assert.equal(await visible(uriOf(author, "self")), true);
});

test("bot: botたんの返信だけ受け付ける", { skip: !testUrl }, async () => {
  const author = did("a2");
  const other = did("o2");
  const parent = uriOf(author, "p");
  await put(author, "p", { replyGate: "bot" });
  await put(other, "r", replyTo(parent));
  await put(BOT, "b", replyTo(parent));
  assert.equal(await visible(uriOf(other, "r")), false);
  assert.equal(await visible(uriOf(BOT, "b")), true);
});

test("制限なしの投稿には誰でも返信でき、通知も届く", { skip: !testUrl }, async () => {
  const author = did("a3");
  const other = did("o3");
  const parent = uriOf(author, "p");
  await put(author, "p");
  await put(other, "r", replyTo(parent));
  assert.equal(await visible(uriOf(other, "r")), true);
  assert.equal(await replyNotifications(uriOf(other, "r")), 1);
});

test("返信が先に届いても、返信先の取り込み時に外す", { skip: !testUrl }, async () => {
  const author = did("a4");
  const other = did("o4");
  const parent = uriOf(author, "p");
  await put(other, "r", replyTo(parent));
  await put(author, "self", replyTo(parent));
  assert.equal(await visible(uriOf(other, "r")), true);
  await put(author, "p", { replyGate: "nobody", botSilent: true });
  assert.equal(await visible(uriOf(other, "r")), false);
  assert.equal(await visible(uriOf(author, "self")), true);
});

test("PostView は閲覧者が返信できないときだけ replyDisabled を返す", { skip: !testUrl }, async () => {
  const author = did("a5");
  const other = did("o5");
  const parent = uriOf(author, "p");
  await put(author, "p", { replyGate: "nobody", botSilent: true });
  // 判定待ちの投稿は表示されないので、判定済みにしてから組み立てる。
  await client`update nagi.posts set moderation_version = 'test' where uri = ${parent}`;
  const rows = await fetchPostRows([parent]);
  const [forOther] = await hydratePostViews(rows, other);
  const [forAuthor] = await hydratePostViews(rows, author);
  assert.equal(forOther.replyDisabled, true);
  assert.equal(forAuthor.replyDisabled, undefined);
});

test("こっそり返信は返信先の制限に反すると拒否する", { skip: !testUrl }, async () => {
  const author = did("a6");
  const root = await createKossoriPost(author, {
    text: "secret",
    createdAt: new Date().toISOString(),
    replyGate: "nobody",
    botSilent: true,
  });
  const reply = {
    root: { uri: root.uri, cid: root.cid },
    parent: { uri: root.uri, cid: root.cid },
  };
  await assert.rejects(
    createKossoriPost(BOT, {
      text: "bot",
      createdAt: new Date().toISOString(),
      reply,
    }),
    /does not accept replies/,
  );
  const own = await createKossoriPost(author, {
    text: "self",
    createdAt: new Date().toISOString(),
    reply,
  });
  assert.equal(await visible(own.uri), true);
});

async function diary(author: string, rkey: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  await applyMutation({
    did: author,
    time_us: Date.now() * 1000 + seq,
    commit: {
      operation: "create",
      collection: "com.suibari.trilinesat.diary",
      rkey,
      cid: `bafyreplygatediary${run}${seq}`,
      record: {
        $type: "com.suibari.trilinesat.diary",
        lines: [{ text: "一" }, { text: "二" }, { text: "三" }],
        createdAt: new Date().toISOString(),
        shareToNagi: true,
        ...extra,
      },
    },
  });
  return `at://${author}/com.suibari.trilinesat.diary/${rkey}`;
}
const botJobs = async (uri: string) =>
  (await client`select source_uri from nagi.bot_reply_jobs where source_uri = ${uri}`).length;

test("3行日記の返信不可は、他人の返信もbotたんの返信ジョブも受け付けない", { skip: !testUrl }, async () => {
  const author = did("a7");
  const other = did("o7");
  const open = await diary(author, "open");
  assert.equal(await botJobs(open), 1);
  const diaryUri = await diary(author, "d", { replyGate: "nobody" });
  assert.equal(await visible(diaryUri), true);
  assert.equal(await botJobs(diaryUri), 0);
  await put(other, "r", replyTo(diaryUri));
  assert.equal(await visible(uriOf(other, "r")), false);
});
