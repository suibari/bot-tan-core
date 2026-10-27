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
    // select がどの表にも同じ行を返すので、ボードの在庫の付け替え（insert）も通る。
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
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

test("退会で置いたカードは残し、提供者と「〜からもらった」を匿名にする", async (t) => {
  const did = "did:plc:leaving";
  const dialect = new PgDialect();
  const deletes: string[] = [];
  const updates: Array<{ table: string; set: any; sql: string; params: unknown[] }> = [];
  const inserts: Array<{ table: string; values: any }> = [];
  const tx = {
    select: () => {
      const chain: any = {
        from: (table: any) => {
          chain.table = getTableConfig(table).name;
          return chain;
        },
        where: () =>
          Promise.resolve(
            chain.table === "card_board_stock"
              ? [{ donorDid: did, cardVolume: 1, cardNumber: 3, count: 2 }]
              : [],
          ),
      };
      return chain;
    },
    insert: (table: any) => ({
      values: (values: any) => {
        inserts.push({ table: getTableConfig(table).name, values });
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    update: (table: any) => ({
      set: (set: any) => ({
        where: async (condition: any) => {
          const { sql, params } = dialect.sqlToQuery(condition);
          updates.push({ table: getTableConfig(table).name, set, sql, params });
        },
      }),
    }),
    delete: (table: any) => ({
      where: async () => {
        deletes.push(getTableConfig(table).name);
      },
    }),
  };
  t.mock.method(database.db, "transaction", async (fn: any) => fn(tx));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));

  await deleteAccountData(did);

  assert.deepEqual(inserts, [
    {
      table: "card_board_stock",
      values: {
        donorDid: database.RECEIVED_FROM_ANONYMOUS,
        cardVolume: 1,
        cardNumber: 3,
        count: 2,
      },
    },
  ]);
  assert.ok(deletes.includes("card_board_stock"));
  const label = updates.find((u) => u.table === "card_instances");
  assert.deepEqual(label?.set, { receivedFromDid: database.RECEIVED_FROM_ANONYMOUS });
  assert.deepEqual(label?.params, [did]);
  const ledger = updates.find((u) => u.table === "zenny_ledger");
  assert.deepEqual(ledger?.set, { counterpartyDid: database.RECEIVED_FROM_ANONYMOUS });
  for (const table of ["zenny_ledger", "zenny_balances"])
    assert.ok(deletes.includes(table), `${table} が消されていない`);
});
