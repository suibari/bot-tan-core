import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const testUrl = process.env.NAGI_DRAFT_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_draft_test");
  process.env.DATABASE_URL = testUrl;
} else process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_draft_test";
const { client } = await import("@bsky-affirmative-bot/database");
const { putDraft, getDraft, getDrafts, deleteDraft } = await import("../src/queries/drafts.js");

before(async () => {
  if (!testUrl) return;
  await client`create schema if not exists nagi`;
  await client`create table if not exists nagi.drafts (
    id uuid primary key, owner_did text not null, content jsonb not null,
    created_at timestamptz not null, updated_at timestamptz not null
  )`;
  // putDraft は書き込み前に非公開データの保存先（space へ移った人か）を確かめる。
  await client.unsafe(
    readFileSync(
      new URL("../../../packages/database/drizzle/0108_nagi_private_spaces.sql", import.meta.url),
      "utf8",
    ),
  );
});
after(() => client.end());

test("HTTPとPostgresの往復でブログ下書きを保持し、別の所有者へ出さない", { skip: !testUrl }, async () => {
  const alice = "did:plc:blog-draft-test";
  const bob = "did:plc:other-draft-test";
  const app = express();
  app.use(express.json());
  app.post("/putDraft", async (req, res) => res.json(await putDraft(alice, req.body)));
  app.get("/getDraft", async (req, res) => res.json(await getDraft(alice, req.query.id)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = crypto.randomUUID();
  const legacyId = crypto.randomUUID();
  const content = { text: "", mentions: [], emojis: [], linkCards: [], dismissedUrls: [],
    articleTitle: "再開するタイトル", articleTags: ["日常", "旅"] };
  const now = new Date().toISOString();
  try {
    const response = await fetch(`${origin}/putDraft`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, content, createdAt: now, updatedAt: now }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id, ...content, createdAt: now, updatedAt: now });
    const restored = await (await fetch(`${origin}/getDraft?id=${id}`)).json();
    assert.deepEqual(restored, { id, ...content, createdAt: now, updatedAt: now });
    assert.deepEqual((await getDrafts(alice)).drafts.find((d) => d.id === id)?.articleTags, content.articleTags);
    await assert.rejects(getDraft(bob, id), /Draft not found/);
    await assert.rejects(putDraft(bob, { id, content, createdAt: now, updatedAt: now }), /Draft not found/);
    const { articleTitle, articleTags, ...legacy } = content;
    await putDraft(alice, { id: legacyId, content: legacy, createdAt: now, updatedAt: now });
    assert.equal((await getDraft(alice, legacyId)).articleTitle, undefined);
    await deleteDraft(bob, id);
    assert.equal((await getDraft(alice, id)).articleTitle, content.articleTitle);
  } finally {
    await deleteDraft(alice, id);
    await deleteDraft(alice, legacyId);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
