import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
const { db } = await import("@bsky-affirmative-bot/database");
const { actorsNeedingReasons, computeReasons, refreshReasons } = await import("../src/NagiThemeWorker.js");

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


test("incomplete and failed users rotate behind waiting users while completion retains its TTL", async (t) => {
  const actors = Array.from({ length: 6 }, (_, i) => ({
    did: `did:plc:${i}`,
    newsReasonsAttemptedAt: null as Date | null,
    // Include an expired completion timestamp as well as never-completed users.
    newsReasonsCheckedAt: i === 5 ? new Date(0) : null as Date | null,
  }));
  const pending = new Map(actors.map(({ did }) => [
    did, Array.from({ length: 65 }, (_, i) => ({ uri: `news:${i}`, title: `title:${i}` })),
  ]));
  const dialect = new PgDialect();
  t.mock.method(db, "select", () => ({ from: () => ({ where: async () => [{ genre: "科学" }] }) }));
  t.mock.method(db, "execute", async (query) => {
    const { sql, params } = dialect.sqlToQuery(query);
    assert.ok(params.every((param) => !(param instanceof Date)));
    if (sql.includes("from nagi.actors a")) {
      assert.match(sql, /a.news_reasons_checked_at is null/);
      assert.match(sql, /a.news_reasons_checked_at < now\(\) - interval '6 hours'/);
      assert.match(sql, /order by a.news_reasons_attempted_at asc nulls first, a.did asc/);
      assert.match(sql, /a.status = 'active'/);
      assert.match(sql, /exists \(select 1 from nagi.actor_interest_genres/);
      return actors
        .filter((a) => !a.newsReasonsCheckedAt || a.newsReasonsCheckedAt.getTime() < Date.now() - 6 * 3600_000)
        .sort((a, b) =>
          (a.newsReasonsAttemptedAt?.getTime() ?? -Infinity) -
            (b.newsReasonsAttemptedAt?.getTime() ?? -Infinity) || a.did.localeCompare(b.did))
        .slice(0, Number(params.at(-1)))
        .map(({ did }) => ({ did }));
    }
    const did = params.find((param) => typeof param === "string" && pending.has(param)) as string;
    return pending.get(did)!.slice(0, 31);
  });
  // Compile real Drizzle updates to check timestamp encoding at the parameter boundary.
  const originalUpdate = db.update.bind(db);
  t.mock.method(db, "update", (table) => ({
    set: (values: { newsReasonsAttemptedAt?: Date; newsReasonsCheckedAt?: Date }) => ({
      where: async (condition) => {
        const query = originalUpdate(table).set(values).where(condition).toSQL();
        assert.ok(query.params.every((param) => !(param instanceof Date)));
        const actor = actors.find((a) => query.params.includes(a.did))!;
        Object.assign(actor, values);
      },
    }),
  }));
  t.mock.method(db, "insert", () => ({
    values: (rows: Array<{ did: string }>) => ({
      onConflictDoUpdate: async () => { pending.get(rows[0].did)!.splice(0, rows.length); },
    }),
  }));
  const match = async (_genres: string[], titles: string[]) => titles.map(() => null);
  const first = await actorsNeedingReasons(4);
  assert.deepEqual(first, ["did:plc:0", "did:plc:1", "did:plc:2", "did:plc:3"]);
  for (const did of first) {
    assert.deepEqual(await refreshReasons(did, match), { matched: 0, complete: false });
    assert.equal(actors.find((a) => a.did === did)!.newsReasonsCheckedAt, null);
  }
  const next = await actorsNeedingReasons(4);
  assert.deepEqual(next.slice(0, 2), ["did:plc:4", "did:plc:5"]);
  await assert.rejects(refreshReasons(next[0], async () => { throw new Error("offline"); }), /offline/);
  const failed = actors.find((a) => a.did === next[0])!;
  assert.ok(failed.newsReasonsAttemptedAt instanceof Date);
  assert.equal(failed.newsReasonsCheckedAt, null);
  assert.equal(pending.get(failed.did)!.length, 65);
  assert.equal((await actorsNeedingReasons(4))[0], "did:plc:5");

  // Successful completion alone starts the TTL, even if every result is unmatched.
  assert.equal((await refreshReasons("did:plc:0", match)).complete, false);
  assert.equal((await refreshReasons("did:plc:0", match)).complete, true);
  assert.ok(actors.find((a) => a.did === "did:plc:0")!.newsReasonsCheckedAt instanceof Date);
  assert.ok(!(await actorsNeedingReasons(6)).includes("did:plc:0"));

  // No pending articles also counts as completion.
  pending.set("did:plc:5", []);
  assert.equal((await refreshReasons("did:plc:5", match)).complete, true);
  assert.ok(!(await actorsNeedingReasons(6)).includes("did:plc:5"));
});
