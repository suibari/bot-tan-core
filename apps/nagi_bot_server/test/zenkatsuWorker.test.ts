import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

// 専用の空DBだけを指定する。通常のテストでは実DBが無ければスキップする。
const url = process.env.ZENKATSU_TEST_DATABASE_URL;
test("即時起動と回収の競合・失敗後のバックオフを実ドライバで検証", { skip: !url }, async () => {
  process.env.DATABASE_URL = url!;
  const { processNagiZenkatsuJob } = await import("../src/NagiZenkatsuWorker.js");
  const sql = postgres(url!);
  let created = false;
  try {
    await sql`create schema nagi`;
    created = true;
    await sql`create table nagi.zenkatsu_comment_jobs (
      submission_uri text primary key, state text not null default 'pending',
      attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
      lease_expires_at timestamptz, last_error text,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`;
    const uri = "at://did:plc:test/com.suibari.nagi.zenkatsu/2026-09-19";
    await sql`insert into nagi.zenkatsu_comment_jobs (submission_uri) values (${uri})`;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = {
      db: drizzle(sql) as NonNullable<Parameters<typeof processNagiZenkatsuJob>[1]>["db"],
      generate: async () => { calls++; await gate; },
    };
    const immediate = processNagiZenkatsuJob(uri, dependencies);
    const recovery = processNagiZenkatsuJob(undefined, dependencies);
    const results = Promise.allSettled([immediate, recovery]);
    // 他の取得が競合する間、生成は未完了にする。
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    for (const result of await results) {
      if (result.status === "rejected") throw result.reason;
    }
    assert.equal(calls, 1);
    await processNagiZenkatsuJob(uri, dependencies);
    assert.equal(calls, 1, "完了済み通知の再送では生成しない");
    assert.equal((await sql`select state from nagi.zenkatsu_comment_jobs`)[0].state, "posted");

    await sql`update nagi.zenkatsu_comment_jobs set state='pending', attempts=0`;
    dependencies.generate = async () => { calls++; throw new Error("offline"); };
    await processNagiZenkatsuJob(uri, dependencies);
    const [failed] = await sql`select * from nagi.zenkatsu_comment_jobs`;
    assert.equal(failed.state, "pending");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.last_error, "offline");
    assert.ok(new Date(failed.next_attempt_at).getTime() > Date.now());
    await processNagiZenkatsuJob(uri, dependencies);
    assert.equal(calls, 2, "即時通知もバックオフを守る");

    // 通知を失ったpendingと、プロセス停止で残った期限切れリースを回収できる。
    dependencies.generate = async () => { calls++; };
    for (const state of ["pending", "processing"]) {
      await sql`update nagi.zenkatsu_comment_jobs set state=${state},
        next_attempt_at=now(), lease_expires_at=now() - interval '1 second'`;
      await processNagiZenkatsuJob(undefined, dependencies);
      assert.equal((await sql`select state from nagi.zenkatsu_comment_jobs`)[0].state, "posted");
    }
    assert.equal(calls, 4);
  } finally {
    if (created) {
      await sql`drop table if exists nagi.zenkatsu_comment_jobs`;
      await sql`drop schema nagi`;
    }
    await sql.end();
  }
});
