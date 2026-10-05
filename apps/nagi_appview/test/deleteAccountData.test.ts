import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const database = await import("@bsky-affirmative-bot/database");
const { getTableConfig, PgDialect } = await import("drizzle-orm/pg-core");
const { deleteAccountData } = await import("../src/services/deleteAccountData.js");

test("退会で botたんの自動リアクション台帳も本人分を消す", async (t) => {
  const did = "did:plc:leaving";
  const dialect = new PgDialect();
  const deletes: Array<{ table: string; sql: string; params: unknown[] }> = [];
  // DB を使わずに発行される delete を記録する。select は常に空。
  const tx = {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => Promise.resolve([]),
      };
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: (table: any) => ({
      where: async (condition: any) => {
        const { sql, params } = dialect.sqlToQuery(condition);
        deletes.push({ table: getTableConfig(table).name, sql, params });
      },
    }),
  };
  t.mock.method(database.db, "transaction", async (fn: any) => fn(tx));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));

  await deleteAccountData(did);

  const index = deletes.findIndex(({ table }) => table === "bot_auto_reactions");
  assert.ok(index >= 0, "bot_auto_reactions が消されていない");
  assert.match(deletes[index].sql, /"bot_auto_reactions"\."subject_did" = \$1/);
  assert.deepEqual(deletes[index].params, [did]);
  assert.ok(
    index < deletes.findIndex(({ table }) => table === "posts"),
    "投稿の行より先に消す",
  );
});

test("退会でこっそり投稿の翻訳キャッシュと、それへのリアクション行も消す", async (t) => {
  const did = "did:plc:leaving";
  // こっそり投稿の URI は AppView の authority なので `at://${did}/...` では引けない。
  const kossoriUri = "at://did:web:nagi.example/com.suibari.nagi.post/opaque";
  const dialect = new PgDialect();
  const deletes: Array<{ table: string; sql: string; params: unknown[] }> = [];
  const tx = {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => Promise.resolve([{ uri: kossoriUri }]),
      };
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: (table: any) => ({
      where: async (condition: any) => {
        const { sql, params } = dialect.sqlToQuery(condition);
        deletes.push({ table: getTableConfig(table).name, sql, params });
      },
    }),
  };
  t.mock.method(database.db, "transaction", async (fn: any) => fn(tx));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));

  await deleteAccountData(did);

  const postsIndex = deletes.findIndex(({ table }) => table === "posts");
  for (const table of ["translations", "reactions", "post_scores"]) {
    const index = deletes.findIndex(
      (entry) => entry.table === table && entry.params.includes(kossoriUri),
    );
    assert.ok(index >= 0, `${table} のこっそり分が消されていない`);
    assert.ok(index < postsIndex, `${table} は投稿の行より先に消す`);
  }
});
