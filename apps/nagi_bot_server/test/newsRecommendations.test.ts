import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
const { db } = await import("@bsky-affirmative-bot/database");
const { computeReasons } = await import("../src/NagiThemeWorker.js");

test("all articles are processed across batches, including unmatched articles beyond the old 30-item cap", async (t) => {
  const pending = Array.from({ length: 65 }, (_, i) => ({ uri: `news:${i}`, title: `title:${i}` }));
  const saved: Array<{ newsUri: string; genre: string | null }> = [];
  t.mock.method(db, "select", () => ({ from: () => ({ where: async () => [{ genre: "科学" }] }) }));
  t.mock.method(db, "execute", async (query) => {
    const { sql, params } = new PgDialect().sqlToQuery(query);
    assert.match(sql, /r.news_uri is null or r.updated_at < a.reviewed_at/);
    assert.match(sql, /n.deleted_at is null/);
    assert.match(sql, /a.hidden_at is null/);
    assert.doesNotMatch(sql, /embedding|interval/);
    assert.ok(params.includes(31));
    assert.ok(params.includes("did:plc:viewer"));
    assert.ok(params.every((param) => !(param instanceof Date)));
    return pending.slice(0, 31);
  });
  t.mock.method(db, "insert", () => ({ values: (rows: typeof saved) => ({ onConflictDoUpdate: async () => {
    saved.push(...rows);
    pending.splice(0, rows.length);
  } }) }));
  const sizes: number[] = [];
  const match = async (_genres: string[], titles: string[]) => {
    sizes.push(titles.length);
    return titles.map((title) => title === "title:64" ? "科学" : null);
  };
  assert.deepEqual(await computeReasons("did:plc:viewer", match), { matched: 0, complete: false });
  assert.deepEqual(await computeReasons("did:plc:viewer", match), { matched: 0, complete: false });
  assert.deepEqual(await computeReasons("did:plc:viewer", match), { matched: 1, complete: true });
  assert.deepEqual(sizes, [30, 30, 5]);
  assert.equal(new Set(saved.map((row) => row.newsUri)).size, 65);
  assert.equal(saved.filter((row) => row.genre === null).length, 64);
  assert.deepEqual(await computeReasons("did:plc:viewer", match), { matched: 0, complete: true });
  assert.deepEqual(sizes, [30, 30, 5]);
});

test("a failed matching request is retried without saving unmatched results", async (t) => {
  t.mock.method(db, "select", () => ({ from: () => ({ where: async () => [{ genre: "科学" }] }) }));
  t.mock.method(db, "execute", async () => [{ uri: "news:1", title: "title" }]);
  const insert = t.mock.method(db, "insert", () => { throw new Error("must not save"); });
  await assert.rejects(computeReasons("did:plc:viewer", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(insert.mock.callCount(), 0);
});
