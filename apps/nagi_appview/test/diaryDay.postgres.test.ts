import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

// 使い捨ての DB 専用（postMood.postgres.test.ts と同じ DB を使う。同時には流さないこと）。
const testUrl = process.env.NAGI_MOOD_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/nagi_mood_test");
  process.env.DATABASE_URL = testUrl;
} else {
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/nagi_mood_test";
}
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { diaryDateOf, diaryDayWindow } = await import("@bsky-affirmative-bot/shared-configs");
const { parseDiaryDayInput } = await import("../src/queries/preferences.js");

const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  for (const table of [
    database.nagiPosts,
    database.nagiDiaries,
    database.nagiDiaryDayPreferences,
    database.nagiDiaryDaySchedules,
    database.followers,
    database.diaryJobs,
  ]) {
    const { schema = "public", name, columns, primaryKeys } = getTableConfig(table);
    await client.unsafe(`create schema if not exists ${quote(schema)}`);
    await client.unsafe(`drop table if exists ${quote(schema)}.${quote(name)}`);
    const keys = primaryKeys[0]?.columns.map((column) => quote(column.name));
    await client.unsafe(
      `create table ${quote(schema)}.${quote(name)} (${[
        ...columns.map(
          (column) =>
            `${quote(column.name)} ${"enum" in column ? "text" : column.getSQLType()}${column.primary ? " primary key" : ""}${column.hasDefault && column.getSQLType().startsWith("timestamp") ? " default now()" : ""}`,
        ),
        ...(keys ? [`primary key (${keys.join(", ")})`] : []),
      ].join(", ")})`,
    );
  }
});
beforeEach(async () => {
  if (!testUrl) return;
  await client`truncate nagi.posts, nagi.diaries, nagi.diary_day_preferences, nagi.diary_day_schedules,
    affirmative_bot.followers, affirmative_bot.diary_jobs`;
});
after(() => client.end());

const alice = "did:plc:alice";

async function post(lang: string) {
  await client`insert into nagi.posts
    (uri, cid, rkey, did, text, record_created_at, indexed_at,
     moderation_labels, self_labels, moderation_version, kossori, record_json, langs)
    values ('at://alice/p/1', 'cid1', '1', ${alice}, 'hi', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z',
      '{}', '{}', 'legacy', false, '{}', ${JSON.stringify([lang])})`;
}
async function diary(date: string) {
  await client`insert into nagi.diaries
    (uri, cid, did, subject_did, diary_date, text, is_private, record_created_at, indexed_at)
    values (${`at://bot/d/${date}`}, 'cid', 'did:plc:bot', ${alice}, ${date}, 'x', false, now(), now())`;
}
const schedules = async () =>
  (
    await client`select effective_from, timezone, start_hour, source
      from nagi.diary_day_schedules where did = ${alice} order by effective_from`
  ).map((row) => [row.effective_from, row.timezone, row.start_hour, row.source]);

test("Bluesky に決まった日の窓は固定し、翌日の変更で再試行期限を延ばす", { skip: !testUrl }, async () => {
  await post("ja");
  await client`insert into affirmative_bot.diary_jobs
    (did, diary_date, surface, status, window_start, window_end, timezone, start_hour, attempts, expires_at)
    values (${alice}, '2026-11-06', 'bsky', 'pending', '2026-11-05T13:00:00Z',
      '2026-11-06T13:00:00Z', 'Asia/Tokyo', 22, 0, '2026-11-07T13:00:00Z')`;
  const state = await database.putDiaryDayPreferences(
    alice, { startHour: 2 }, new Date("2026-11-06T23:00:00+09:00"),
  );
  assert.equal(state.current.effectiveFrom, "2026-11-07");
  const history = await database.loadDiaryDayHistory(alice);
  assert.equal(diaryDayWindow("2026-11-06", history).startHour, 22);
  const [job] = await client`select window_end, expires_at from affirmative_bot.diary_jobs`;
  assert.equal(new Date(job.window_end).toISOString(), "2026-11-06T13:00:00.000Z");
  assert.equal(new Date(job.expires_at).toISOString(), "2026-11-07T17:00:00.000Z");
});

test("初めての自動検出で、それまでの推定を baseline として凍結する", { skip: !testUrl }, async () => {
  await post("en");
  await diary("2026-11-05");
  // ロンドン 11/6 12:00。英語は言語からの推定ではロンドン以外になる（ここでずれていた）。
  const now = new Date("2026-11-06T12:00:00Z");
  const state = await database.putDiaryDayPreferences(alice, { detectedTimezone: "Europe/London" }, now);
  const rows = await schedules();
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], "1970-01-01");
  assert.equal(rows[0][3], "baseline");
  assert.notEqual(rows[0][1], "Europe/London");
  assert.equal(rows[1][1], "Europe/London");
  assert.equal(rows[1][3], "auto");
  assert.ok(state.pending || state.current.timezone === "Europe/London");

  // 同じ値がもう一度届いても何も増えない。
  await database.putDiaryDayPreferences(alice, { detectedTimezone: "Europe/London" }, now);
  assert.equal((await schedules()).length, 2);

  // 過去の日（書いた日記）は当時の区切りのまま。
  const history = await database.loadDiaryDayHistory(alice);
  assert.equal(diaryDayWindow("2026-11-05", history).timezone, rows[0][1]);
});

test("区切りの変更: 今日の日記が書かれていれば翌日から、予約は置き換え、戻せば消える", { skip: !testUrl }, async () => {
  await post("ja");
  await diary("2026-11-06");
  const now = new Date("2026-11-06T23:00:00+09:00");
  // 23時には 11/6 の日記が書かれていて、今開いているのは 11/7 の日。そこから 2時区切り。
  const first = await database.putDiaryDayPreferences(alice, { startHour: 2 }, now);
  assert.deepEqual(first.current, { timezone: "Asia/Tokyo", startHour: 2, effectiveFrom: "2026-11-07" });
  assert.equal(first.pending, undefined);

  // 2時→4時に変えると、同じ日の行が置き換わる。
  const second = await database.putDiaryDayPreferences(alice, { startHour: 4 }, now);
  assert.equal(second.current.startHour, 4);
  assert.equal((await schedules()).length, 2);

  // 22時に戻すとその行が消える。
  const reverted = await database.putDiaryDayPreferences(alice, { startHour: 22 }, now);
  assert.deepEqual(reverted.current, { timezone: "Asia/Tokyo", startHour: 22 });
  assert.equal((await schedules()).length, 1);

  // 20時に18時区切りへ（今日の18時は過ぎていて、11/6 の日記もある）。11/7 からの予約になる。
  const early = await database.putDiaryDayPreferences(
    alice,
    { startHour: 18 },
    new Date("2026-11-06T20:00:00+09:00"),
  );
  assert.deepEqual(early.pending, { effectiveFrom: "2026-11-07", timezone: "Asia/Tokyo", startHour: 18 });
});

test("手動のタイムゾーンは自動検出より優先し、null で自動に戻る", { skip: !testUrl }, async () => {
  await post("ja");
  const now = new Date("2026-11-06T03:00:00Z");
  await database.putDiaryDayPreferences(alice, { manualTimezone: "Asia/Tokyo" }, now);
  const auto = await database.putDiaryDayPreferences(
    alice,
    { detectedTimezone: "America/New_York" },
    now,
  );
  assert.equal(auto.manualTimezone, "Asia/Tokyo");
  assert.equal(auto.detectedTimezone, "America/New_York");
  assert.equal(auto.pending, undefined);
  assert.equal(auto.current.timezone, "Asia/Tokyo");

  const back = await database.putDiaryDayPreferences(alice, { manualTimezone: null }, now);
  assert.equal(back.manualTimezone, undefined);
  assert.equal(
    back.pending?.timezone ?? back.current.timezone,
    "America/New_York",
  );
});

test("設定変更の前後で日付が連続する", { skip: !testUrl }, async () => {
  await post("ja");
  const now = new Date("2026-11-06T20:00:00+09:00");
  await database.putDiaryDayPreferences(alice, { startHour: 2 }, now);
  const history = await database.loadDiaryDayHistory(alice);
  // 11/6 の日が 11/7 02:00 まで伸びる。
  assert.equal(diaryDateOf(new Date("2026-11-06T23:30:00+09:00"), history), "2026-11-06");
  assert.equal(diaryDateOf(new Date("2026-11-07T01:59:00+09:00"), history), "2026-11-06");
  assert.equal(diaryDateOf(new Date("2026-11-07T02:00:01+09:00"), history), "2026-11-07");
  // 前の日は22時区切りのまま。
  assert.equal(diaryDateOf(new Date("2026-11-05T22:30:00+09:00"), history), "2026-11-06");
  assert.equal(diaryDateOf(new Date("2026-11-05T21:30:00+09:00"), history), "2026-11-05");
});

test("入力の検証: 自動の UTC は黙って捨て、手動の不正値は 400", () => {
  assert.equal(parseDiaryDayInput("UTC", undefined), undefined);
  assert.deepEqual(parseDiaryDayInput("Europe/London", undefined), {
    detectedTimezone: "Europe/London",
  });
  assert.deepEqual(parseDiaryDayInput(undefined, { timezone: null, startHour: 2 }), {
    manualTimezone: null,
    startHour: 2,
  });
  assert.throws(() => parseDiaryDayInput(undefined, { startHour: 12 }), /diaryDay.startHour/);
  assert.throws(() => parseDiaryDayInput(undefined, { timezone: "Mars/Base" }), /diaryDay.timezone/);
  assert.throws(() => parseDiaryDayInput(undefined, "x"), /diaryDay/);
});
