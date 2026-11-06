import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての DB 専用（nagi_appview の postgres テストと同じ DB。同時には流さないこと）。
const testUrl = process.env.NAGI_MOOD_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_mood_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_mood_test";
}
process.env.DEVELOPER_DID = "";
delete process.env.NAGI_BOT_DID;
delete process.env.BSKY_DID;

const database = await import("../src/index.js");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");

const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
const literal = (value: unknown) =>
  typeof value === "number" ? String(value) : typeof value === "string" ? `'${value}'` : undefined;

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [
    database.nagiPosts,
    database.nagiDiaries,
    database.nagiDiaryDaySchedules,
    database.followers,
    database.subscribers,
    database.diaryJobs,
  ]) {
    const { schema = "public", name, columns, primaryKeys } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    const keys = primaryKeys[0]?.columns.map((column) => quote(column.name));
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${[
        ...columns.map((column) => {
          const type = "enum" in column ? "text" : column.getSQLType();
          const fallback = literal(column.default);
          const def = column.hasDefault
            ? fallback !== undefined
              ? ` default ${fallback}`
              : type.startsWith("timestamp")
                ? " default now()"
                : ""
            : "";
          return `${quote(column.name)} ${type}${column.primary ? " primary key" : ""}${def}`;
        }),
        ...(keys ? [`primary key (${keys.join(", ")})`] : []),
      ].join(", ")})`,
    );
  }
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.diaries, nagi.diary_day_schedules,
    affirmative_bot.followers, affirmative_bot.subscribers, affirmative_bot.diary_jobs`;
});
after(() => client.end());

const alice = "did:plc:alice";
const bob = "did:plc:bob";
let postId = 0;

async function nagiPost(did: string, at: string, lang = "ja") {
  postId += 1;
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_created_at, indexed_at,
     moderation_labels, self_labels, moderation_version, kossori, record_json, langs)
    values (${`at://${did}/p/${postId}`}, 'cid', ${String(postId)}, ${did}, 'hi', ${at}, ${at},
      '{}', '{}', 'legacy', false, '{}', ${JSON.stringify([lang])})`;
}
async function blueskyDiaryUser(did: string, lang?: string) {
  await client`insert into affirmative_bot.followers (did, is_diary, diary_bsky_lang)
    values (${did}, 1, ${lang ?? null})`;
  await client`insert into affirmative_bot.subscribers (did, status) values (${did}, 'active')`;
}
async function schedule(did: string, effectiveFrom: string, startHour: number, timezone = "Asia/Tokyo") {
  await client`insert into nagi.diary_day_schedules (did, effective_from, timezone, start_hour, source)
    values (${did}, ${effectiveFrom}, ${timezone}, ${startHour}, 'manual')`;
}
const jobs = async () =>
  (
    await client`select did, diary_date, surface, status, attempts, timezone, start_hour
      from affirmative_bot.diary_jobs order by did, diary_date`
  ).map((row) => ({ ...row }));

test("Nagi に投稿した日は Nagi に決まり、二重には決まらない", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  assert.equal(await database.decideDiaryJobs(now), 1);
  assert.equal(await database.decideDiaryJobs(now), 0);
  const [job] = await jobs();
  assert.equal(job.surface, "nagi");
  assert.equal(job.diary_date, "2026-11-06");
  assert.equal(job.timezone, "Asia/Tokyo");
});

test("窓が閉じてすぐ（猶予の5分以内）は決めない", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  // 22:03 の時点で決まるのは、とうに閉じた前の日（11/5。投稿が無いので none）だけ。
  await database.decideDiaryJobs(new Date("2026-11-06T22:03:00+09:00"));
  assert.deepEqual((await jobs()).map((job) => job.diary_date), ["2026-11-05"]);
  await database.decideDiaryJobs(new Date("2026-11-06T22:06:00+09:00"));
  assert.deepEqual((await jobs()).map((job) => job.diary_date), ["2026-11-05", "2026-11-06"]);
});

test("取って、失敗したら1時間後に試し直し、書けたら終わる", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  await database.decideDiaryJobs(now);
  assert.equal((await database.claimDiaryJobs("bsky", now)).length, 0);
  const [job] = await database.claimDiaryJobs("nagi", now);
  assert.equal(job.window.date, "2026-11-06");
  assert.equal(job.attempts, 1);
  // 実行中は取れない。
  assert.equal((await database.claimDiaryJobs("nagi", now)).length, 0);

  await database.finishDiaryJob(job, "failed", undefined, now);
  const later = new Date(now.getTime() + 30 * 60_000);
  assert.equal((await database.claimDiaryJobs("nagi", later)).length, 0);
  const retry = new Date(now.getTime() + 61 * 60_000);
  const [again] = await database.claimDiaryJobs("nagi", retry);
  assert.equal(again.attempts, 2);
  await database.finishDiaryJob(again, "done", undefined, retry);
  assert.equal((await jobs())[0].status, "done");
});

test("実行中のまま落ちたら、期限を過ぎて拾い直す。次の日の窓が閉じたら打ち切る", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  await database.decideDiaryJobs(now);
  await database.claimDiaryJobs("nagi", now);
  const afterLease = new Date(now.getTime() + 4 * 3_600_000 + 60_000);
  assert.equal((await database.claimDiaryJobs("nagi", afterLease)).length, 1);

  const nextDay = new Date("2026-11-07T22:30:00+09:00");
  await database.decideDiaryJobs(nextDay);
  const [old] = await jobs();
  assert.equal(old.status, "expired");
});

test("Bluesky の日記モードの人は、Nagi に投稿が無ければ Bluesky。タイムゾーンは Bluesky の言語から", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(bob, "en");
  // en は America/New_York。11/6 22:00 EST = 11/7 03:00Z。
  assert.equal(await database.decideDiaryJobs(new Date("2026-11-07T03:10:00Z")), 1);
  const [job] = await jobs();
  assert.equal(job.surface, "bsky");
  assert.equal(job.timezone, "America/New_York");
  assert.equal(job.diary_date, "2026-11-06");
});

test("Nagi の区切りを2時にした人の、22時以降だけの Nagi 投稿は Nagi に決まる（二重にならない）", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(alice);
  await schedule(alice, "1970-01-01", 2);
  await nagiPost(alice, "2026-11-06T23:30:00+09:00");
  // 22時では、まだ 11/6 の窓が閉じていないので何も決まらない（以前は Bluesky が書いていた）。
  assert.equal(await database.decideDiaryJobs(new Date("2026-11-06T22:10:00+09:00")), 1);
  assert.deepEqual(
    (await jobs()).map((job) => [job.diary_date, job.surface]),
    [["2026-11-05", "bsky"]],
  );
  await database.decideDiaryJobs(new Date("2026-11-07T02:10:00+09:00"));
  const rows = await jobs();
  assert.deepEqual(rows.at(-1), {
    ...rows.at(-1),
    diary_date: "2026-11-06",
    surface: "nagi",
    start_hour: 2,
  });
});

test("Nagi に最近投稿していても、その日に投稿が無く日記モードでもなければ書かない", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-05T12:00:00+09:00");
  await database.decideDiaryJobs(new Date("2026-11-06T22:10:00+09:00"));
  const [job] = await jobs();
  assert.equal(job.diary_date, "2026-11-06");
  assert.equal(job.surface, "none");
  assert.equal(job.status, "skipped");
  assert.equal((await database.claimDiaryJobs("nagi", new Date("2026-11-06T22:10:00+09:00"))).length, 0);
});

test("両サーバーが同時に決めても1行、同時に取っても実行は1つ", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(alice, "ja");
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  const created = await Promise.all([database.decideDiaryJobs(now), database.decideDiaryJobs(now)]);
  assert.equal(created[0] + created[1], 1);
  const claimed = await Promise.all([database.claimDiaryJobs("nagi", now), database.claimDiaryJobs("nagi", now)]);
  assert.equal(claimed.flat().length, 1);
  assert.equal((await database.claimDiaryJobs("bsky", now)).length, 0);
});

test("古い実行の完了通知で、期限切れ後に拾い直した実行を上書きしない", { skip: !testUrl }, async () => {
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  await database.decideDiaryJobs(now);
  const [old] = await database.claimDiaryJobs("nagi", now);
  const later = new Date(now.getTime() + database.DIARY_JOB_LEASE_MS + 1);
  const [current] = await database.claimDiaryJobs("nagi", later);
  await database.finishDiaryJob(old, "done", undefined, later);
  assert.equal((await jobs())[0].status, "running");
  await database.finishDiaryJob(current, "done", undefined, later);
  assert.equal((await jobs())[0].status, "done");
});

test("移行前に Bluesky へ書いた日は、Nagi に投稿があっても書き直さない", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(alice, "ja");
  await client`update affirmative_bot.followers set last_diary_date = '2026-11-06' where did = ${alice}`;
  await nagiPost(alice, "2026-11-06T12:00:00+09:00");
  const now = new Date("2026-11-06T22:10:00+09:00");
  await database.decideDiaryJobs(now);
  assert.equal((await jobs())[0].surface, "bsky");
  assert.equal((await jobs())[0].status, "done");
  assert.equal((await database.claimDiaryJobs("nagi", now)).length, 0);
  assert.equal((await database.claimDiaryJobs("bsky", now)).length, 0);
});

test("再試行は固定24時間でなく、夏時間を含む次の日の窓の終わりまで", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(bob, "en");
  await schedule(bob, "1970-01-01", 22, "America/New_York");
  const now = new Date("2026-10-31T22:10:00-04:00");
  await database.decideDiaryJobs(now);
  const [row] = await client`select expires_at from affirmative_bot.diary_jobs`;
  assert.equal(new Date(row.expires_at).toISOString(), "2026-11-02T03:00:00.000Z");
  // 翌日は25時間ある。24時間を過ぎても、窓が閉じるまでは拾える。
  assert.equal((await database.claimDiaryJobs("bsky", new Date("2026-11-01T22:30:00-04:00"))).length, 1);
});

test("区切り変更で次の日が長くなっても、次の窓が閉じるまでは再試行できる", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(alice, "ja");
  await schedule(alice, "1970-01-01", 22);
  await schedule(alice, "2026-11-07", 2);
  const now = new Date("2026-11-06T22:10:00+09:00");
  await database.decideDiaryJobs(now);
  const [row] = await client`select expires_at from affirmative_bot.diary_jobs`;
  assert.equal(new Date(row.expires_at).toISOString(), "2026-11-07T17:00:00.000Z");
  assert.equal((await database.claimDiaryJobs("bsky", new Date("2026-11-07T23:00:00+09:00"))).length, 1);
});

test("Nagi を離れて Bluesky に戻っても、設定済みのタイムゾーンと区切りを使う", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(bob, "en");
  await schedule(bob, "1970-01-01", 2, "Europe/London");
  const now = new Date("2026-11-07T02:10:00Z");
  await database.decideDiaryJobs(now);
  const [job] = await database.claimDiaryJobs("bsky", now);
  assert.equal(job.window.timezone, "Europe/London");
  assert.equal(job.window.startHour, 2);
  assert.equal(job.window.date, "2026-11-06");
});

test("書き先の判定も窓の開始を含まず、終了を含む", { skip: !testUrl }, async () => {
  await blueskyDiaryUser(alice, "ja");
  await blueskyDiaryUser(bob, "ja");
  await nagiPost(alice, "2026-11-05T22:00:00+09:00");
  await nagiPost(bob, "2026-11-06T22:00:00+09:00");
  await database.decideDiaryJobs(new Date("2026-11-06T22:10:00+09:00"));
  assert.deepEqual((await jobs()).map((job) => [job.did, job.surface]), [[alice, "bsky"], [bob, "nagi"]]);
});
