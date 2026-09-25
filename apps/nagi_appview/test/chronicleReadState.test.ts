import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

process.env.NAGI_BOT_DID ??= "did:plc:testbot";
const testUrl = process.env.CHRONICLE_TEST_DATABASE_URL;
if (testUrl) {
  assert.equal(new URL(testUrl).pathname, "/chronicle_sync_test");
  process.env.DATABASE_URL = testUrl;
} else process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
const database = await import("@bsky-affirmative-bot/database");
const { client } = database;
const { getTableConfig } = await import("drizzle-orm/pg-core");
const { getPreferences, putPreferences } =
  await import("../src/queries/preferences.js");
const { getChronicle, chronicleYearRevision } =
  await import("../src/queries/chronicle.js");
const { parseChronicleReadYears } =
  await import("../src/queries/chronicleReadState.js");
const { cardDrawDate } = await import("@bsky-affirmative-bot/shared-configs");
const year = Number(cardDrawDate().slice(0, 4));

before(async () => {
  if (!testUrl) return;
  await client`create extension if not exists vector`;
  await client`create schema if not exists nagi`;
  await client.unsafe(
    await readFile(
      new URL(
        "../../../packages/database/drizzle/0080_nagi_chronicle_read_years.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Real DB queries throughout the preferences and chronicle paths; unrelated
  // settings and source tables start empty, with their real column definitions.
  const schemas = new Set(["nagi"]);
  for (const table of [
    database.nagiReadPositions,
    database.nagiEmojiFavorites,
    database.nagiFeedTabs,
    database.nagiPreferredNames,
    database.followers,
    database.nagiLanguagePreferences,
    database.nagiModerationPreferences,
    database.nagiBookmarkPreferences,
    database.nagiAgeAssurance,
    database.nagiProfiles,
    database.nagiCardGets,
    database.nagiCardInstances,
    database.nagiChronicleEvents,
    database.nagiChronicleNews,
  ]) {
    const { schema = "public", name, columns } = getTableConfig(table);
    const quote = (id: string) => '"' + id.replaceAll('"', '""') + '"';
    if (!schemas.has(schema)) {
      await client.unsafe(`create schema if not exists ${quote(schema)}`);
      schemas.add(schema);
    }
    await client.unsafe(
      `create table if not exists ${quote(schema)}.${quote(name)} (${columns
        .map(
          (column) =>
            `${quote(column.name)} ${"enum" in column ? "text" : column.getSQLType()}`,
        )
        .join(", ")})`,
    );
  }
});
after(() => client.end());
const read = (page: { year: number; revision: string }) => ({
  year: page.year,
  revision: page.revision,
});
const pageFor = (
  did: string,
  forYear = year,
  limit = 100,
  lang: "ja" | "en" = "ja",
) =>
  getChronicle({
    actor: did,
    viewerDid: did,
    cursor: String(forYear),
    limit,
    lang,
  });
async function addEvent(did: string, forYear = year, title = "出来事") {
  const id = randomUUID();
  await client`insert into nagi.chronicle_events (id, subject_did, event_date, kind, title_ja, title_en)
    values (${id}, ${did}, ${`${forYear}-01-02`}, 'highlight', ${title}, 'Event')`;
  return id;
}
async function cleanup(did: string) {
  await client`delete from nagi.chronicle_read_years where did = ${did}`;
  await client`delete from nagi.chronicle_events where subject_did = ${did}`;
  await client`delete from nagi.profiles where did = ${did}`;
}

test("read input accepts bounded real years and hashes, without a lifetime revision quota", () => {
  const value = { year, revision: "a".repeat(64) };
  assert.deepEqual(parseChronicleReadYears(undefined), []);
  assert.deepEqual(parseChronicleReadYears([value]), [value]);
  for (const bad of [
    null,
    {},
    [null],
    [{ ...value, year: 2019 }],
    [{ ...value, year: year + 1 }],
    [{ ...value, year: String(year) }],
    [{ ...value, revision: "bad" }],
    [value, value],
    Array(101).fill(value),
  ])
    assert.throws(() => parseChronicleReadYears(bad));
});

test("year hash is order/language independent and changes for edits, additions, deletions and news replacement", () => {
  const a = {
    id: "a",
    kind: "highlight" as const,
    date: `${year}-01-02`,
    titleJa: "最初",
  };
  const b = { ...a, id: "b" };
  const hash = chronicleYearRevision(year, [a, b]);
  assert.equal(hash, chronicleYearRevision(year, [b, a]));
  assert.notEqual(
    hash,
    chronicleYearRevision(year, [a, { ...b, titleJa: "更新" }]),
  );
  assert.notEqual(hash, chronicleYearRevision(year, [a]));
  assert.notEqual(hash, chronicleYearRevision(year, [a, b, { ...a, id: "c" }]));
  const ja = {
    ...a,
    news: { uri: "at://news/one", cid: "cid1", title: "日本語", lang: "ja" },
  } as Parameters<typeof chronicleYearRevision>[1][number];
  const en = {
    ...ja,
    news: { ...ja.news!, title: "English", lang: "en" as const },
  };
  assert.equal(
    chronicleYearRevision(year, [ja]),
    chronicleYearRevision(year, [en]),
  );
  assert.notEqual(
    chronicleYearRevision(year, [ja]),
    chronicleYearRevision(year, [
      { ...ja, news: { ...ja.news!, cid: "cid2" } },
    ]),
  );
  assert.notEqual(
    chronicleYearRevision(year, []),
    chronicleYearRevision(year - 1, []),
  );
});

test(
  "preferences PUT/GET sync per year, preserve unread years, and reject fabricated or stale states",
  { skip: !testUrl },
  async () => {
    const did = `did:test:${randomUUID()}`;
    const other = `did:test:${randomUUID()}`;
    try {
      // Establish a valid origin so both years are real pages for this account.
      await client`insert into nagi.profiles (did, created_at) values (${did}, ${`${year - 1}-01-01T12:00:00Z`}::timestamptz)`;
      const id = await addEvent(did);
      await addEvent(did, year - 1);
      const first = read(await pageFor(did));
      const previous = read(await pageFor(did, year - 1));
      assert.deepEqual((await getPreferences(did)).chronicleReadYears, []);
      assert.deepEqual(
        (await putPreferences(did, { chronicleReadYears: [first] }))
          .chronicleReadYears,
        [first],
      );
      assert.deepEqual((await getPreferences(did)).chronicleReadYears, [first]);
      assert.deepEqual((await getPreferences(other)).chronicleReadYears, []);
      // Reading this year does not implicitly read another year.
      assert.equal(
        (await getPreferences(did)).chronicleReadYears!.some(
          (r) => r.year === year - 1,
        ),
        false,
      );
      const union = [previous, first];
      assert.deepEqual(
        (await putPreferences(did, { chronicleReadYears: [previous] }))
          .chronicleReadYears,
        union,
      );
      assert.deepEqual(
        (await putPreferences(did, {})).chronicleReadYears,
        union,
      );
      assert.deepEqual(
        (await putPreferences(did, { chronicleReadYears: [] }))
          .chronicleReadYears,
        union,
      );
      // Arbitrary hashes do not replace an existing year or allocate a new row.
      assert.deepEqual(
        (
          await putPreferences(did, {
            chronicleReadYears: [{ year, revision: "f".repeat(64) }],
          })
        ).chronicleReadYears,
        union,
      );
      assert.deepEqual(
        (await putPreferences(other, { chronicleReadYears: [first] }))
          .chronicleReadYears,
        [],
      );
      await assert.rejects(
        () =>
          putPreferences(did, {
            chronicleReadYears: [{ year: 2019, revision: first.revision }],
          }),
        { status: 400 },
      );
      await assert.rejects(() => pageFor(did, year - 2), { status: 400 });
      await client`update nagi.chronicle_events set title_ja = '更新' where id = ${id}`;
      const updated = read(await pageFor(did));
      assert.notEqual(updated.revision, first.revision);
      assert.equal(
        (await getPreferences(did)).chronicleReadYears!.find(
          (r) => r.year === year,
        )!.revision,
        first.revision,
      );
      await Promise.all([
        putPreferences(did, { chronicleReadYears: [updated] }),
        putPreferences(did, { chronicleReadYears: [first] }),
      ]);
      assert.deepEqual(
        (await putPreferences(did, { chronicleReadYears: [first] }))
          .chronicleReadYears,
        [previous, updated],
      );
      assert.deepEqual((await getPreferences(did)).chronicleReadYears, [
        previous,
        updated,
      ]);
      const [count] =
        await client`select count(*)::int as count from nagi.chronicle_read_years where did = ${did}`;
      assert.equal(count.count, 2);
    } finally {
      await cleanup(did);
      await cleanup(other);
    }
  },
);

test(
  "complete years are never truncated; repeated edits and empty-year deletion keep one persisted row",
  { skip: !testUrl },
  async () => {
    const did = `did:test:${randomUUID()}`;
    try {
      const ids = [];
      for (let i = 0; i < 55; i++)
        ids.push(await addEvent(did, year, `項目${i}`));
      const page = await pageFor(did, year, 1);
      assert.equal(page.items.length, 55);
      assert.equal(
        page.revision,
        (await pageFor(did, year, 100, "en")).revision,
      );
      await putPreferences(did, { chronicleReadYears: [read(page)] });
      for (let i = 0; i < 5; i++) {
        await client`update nagi.chronicle_events set title_ja = ${`改訂${i}`} where id = ${ids[0]}`;
        const current = read(await pageFor(did));
        assert.deepEqual(
          (await putPreferences(did, { chronicleReadYears: [current] }))
            .chronicleReadYears,
          [current],
        );
      }
      await client`delete from nagi.chronicle_events where subject_did = ${did}`;
      const empty = await pageFor(did);
      assert.equal(empty.items.length, 0);
      assert.notEqual(
        (await getPreferences(did)).chronicleReadYears![0].revision,
        empty.revision,
      );
      assert.deepEqual(
        (await putPreferences(did, { chronicleReadYears: [read(empty)] }))
          .chronicleReadYears,
        [read(empty)],
      );
      const [count] =
        await client`select count(*)::int as count from nagi.chronicle_read_years where did = ${did}`;
      assert.equal(count.count, 1);
    } finally {
      await cleanup(did);
    }
  },
);
