import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const testUrl = process.env.CHRONICLE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/chronicle_sync_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
}
const { client } = await import("@bsky-affirmative-bot/database");
const {
  addChronicleReadRevisions,
  getChronicleReadRevisions,
  parseChronicleReadRevisions,
} = await import("../src/queries/chronicleReadState.js");
after(() => client.end());

test("既読はSHA-256だけを受理し、重複を除き、1回200件に制限する", () => {
  const revision = "a".repeat(64);
  assert.deepEqual(parseChronicleReadRevisions(undefined), []);
  assert.deepEqual(parseChronicleReadRevisions([revision, revision]), [
    revision,
  ]);
  for (const input of [
    null,
    {},
    "hash",
    [null],
    [123],
    ["g".repeat(64)],
    ["a".repeat(63)],
    Array(201).fill(revision),
  ])
    assert.throws(() => parseChronicleReadRevisions(input));
});

test(
  "実DBで2端末の同時保存を和集合にし、古い再送でも戻さず、別アカウントに漏らさない",
  {
    skip: !testUrl,
  },
  async () => {
    await client`create schema if not exists nagi`;
    await client.unsafe(
      await readFile(
        new URL(
          "../../../packages/database/drizzle/0080_nagi_chronicle_read_revisions.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const alice = `did:test:${randomUUID()}`;
    const bob = `did:test:${randomUUID()}`;
    const original = "a".repeat(64);
    const edited = "b".repeat(64);
    const otherPage = "c".repeat(64);
    try {
      await Promise.all([
        addChronicleReadRevisions(alice, [original]),
        addChronicleReadRevisions(alice, [edited, otherPage]),
        addChronicleReadRevisions(bob, [original]),
      ]);
      await addChronicleReadRevisions(alice, [original]);
      await addChronicleReadRevisions(alice, []);
      assert.deepEqual(
        new Set(await getChronicleReadRevisions(alice)),
        new Set([original, edited, otherPage]),
      );
      assert.deepEqual(await getChronicleReadRevisions(bob), [original]);
      assert.deepEqual(await getChronicleReadRevisions("did:test:unknown"), []);
    } finally {
      await client`delete from nagi.chronicle_read_revisions where did in (${alice}, ${bob})`;
    }
  },
);
