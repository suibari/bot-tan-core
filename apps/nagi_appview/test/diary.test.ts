import assert from "node:assert/strict";
import test from "node:test";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";
import {
  diaryInteractionWindow,
  diaryView,
  moodDiaryDate,
  rankDiaryInteractionActors,
  validateDiaryRange,
} from "../src/queries/diaries.js";

const diaryRecord = (extra: Record<string, unknown> = {}) => ({
  $type: NAGI.diary,
  subject: "did:plc:alice",
  date: "2026-08-02",
  text: "今日の日記",
  createdAt: "2026-08-02T13:00:00.000Z",
  ...extra,
});

test("validates legacy and activity diary records", () => {
  assert.equal(validateRecord(NAGI.diary, diaryRecord()), true);
  assert.equal(
    validateRecord(NAGI.diary, diaryRecord({ emoji: "🌱", postCount: 3 })),
    true,
  );
  assert.equal(
    validateRecord(NAGI.diary, diaryRecord({ emoji: "👩‍💻", postCount: 1 })),
    true,
  );
  assert.equal(
    validateRecord(NAGI.diary, diaryRecord({ emoji: "🍜🚃🎸", postCount: 2 })),
    true,
  );
});

test("keeps read compatibility for legacy 1-or-3 emoji records", () => {
  for (const emoji of ["🌱✨", "🍜🚃🎸📚"]) {
    assert.equal(
      validateRecord(NAGI.diary, diaryRecord({ emoji, postCount: 2 })),
      false,
    );
  }
});

test("rejects invalid post counts", () => {
  for (const postCount of [0, -1, 1.5, "2"]) {
    assert.equal(
      validateRecord(NAGI.diary, diaryRecord({ emoji: "🌱", postCount })),
      false,
    );
  }
});

test("diary view is returned only to the diary owner", () => {
  const base = {
    uri: "at://did:web:nagi-api.suibari.com/com.suibari.nagi.diary/alice-2026-08-02",
    cid: "bafyreidiary",
    did: "did:plc:bot",
    subjectDid: "did:plc:alice",
    diaryDate: "2026-08-02",
    text: "今日の日記",
    titleJa: null,
    titleEn: null,
    langs: null,
    isPrivate: false,
    recordCreatedAt: new Date("2026-08-02T13:00:00.000Z"),
    indexedAt: new Date("2026-08-02T13:00:01.000Z"),
  };
  const involved = [{ did: "did:plc:bob", handle: "bob.test" }];

  // 他人と未認証には、日付や件数も含めて何も返さない。
  for (const viewer of ["did:plc:bob", undefined]) {
    assert.equal(
      diaryView({ ...base, emoji: null, postCount: 4 }, viewer, involved, true),
      undefined,
    );
  }

  assert.deepEqual(
    diaryView({ ...base, emoji: null, postCount: null }, base.subjectDid),
    {
      uri: base.uri,
      cid: base.cid,
      subject: base.subjectDid,
      date: base.diaryDate,
      text: base.text,
      titleJa: undefined,
      titleEn: undefined,
      postCount: undefined,
      involvedActors: undefined,
      involvedActorsHasMore: undefined,
      langs: undefined,
      createdAt: base.recordCreatedAt.toISOString(),
      indexedAt: base.indexedAt.toISOString(),
    },
  );

  const view = diaryView(
    { ...base, emoji: "🍜🚃🎸", postCount: 4 },
    base.subjectDid,
    involved,
  )!;
  assert.equal(view.postCount, 4);
  assert.deepEqual(view.involvedActors, involved);
  assert.equal(view.involvedActorsHasMore, undefined);
  assert.equal(
    diaryView(
      { ...base, emoji: null, postCount: 4 },
      base.subjectDid,
      involved,
      true,
    )!.involvedActorsHasMore,
    true,
  );
  assert.equal("emoji" in view, false);
});

test("diaries with kossori posts are shown to their owner like any other diary", () => {
  const row = {
    uri: "at://did:web:nagi-api.suibari.com/com.suibari.nagi.diary/alice-2026-08-02",
    cid: "bafyreidiary",
    did: "did:plc:bot",
    subjectDid: "did:plc:alice",
    diaryDate: "2026-08-02",
    text: "こっそりを含む日の日記",
    titleJa: "今日の称号",
    titleEn: "title",
    emoji: null,
    postCount: 4,
    isPrivate: true,
    langs: ["ja"],
    recordCreatedAt: new Date("2026-08-02T13:00:00.000Z"),
    indexedAt: new Date("2026-08-02T13:00:01.000Z"),
  };

  const mine = diaryView(row, "did:plc:alice")!;
  assert.equal(mine.text, row.text);
  assert.equal(mine.titleJa, "今日の称号");
  assert.equal("isPrivate" in mine, false);
  assert.equal("bodyHidden" in mine, false);
  assert.equal(diaryView(row, "did:plc:bob"), undefined);
});

test("accepts at most 371 inclusive days for the annual diary graph", () => {
  assert.doesNotThrow(() => validateDiaryRange("2025-08-10", "2026-08-15"));
  assert.throws(
    () => validateDiaryRange("2025-08-09", "2026-08-15"),
    /too large/,
  );
  assert.throws(
    () => validateDiaryRange("2026-08-16", "2026-08-15"),
    /Invalid diary date range/,
  );
});

test("uses the same local 22:00 cutoff as Japanese diary generation", () => {
  const row = {
    uri: "at://did:plc:bot/com.suibari.nagi.diary/alice-2026-08-02",
    cid: "bafyreidiary",
    did: "did:plc:bot",
    subjectDid: "did:plc:alice",
    diaryDate: "2026-08-02",
    text: "今日の日記",
    titleJa: null,
    titleEn: null,
    emoji: null,
    postCount: 1,
    isPrivate: false,
    langs: ["ja"],
    recordCreatedAt: new Date("2026-08-02T13:00:00.000Z"),
    indexedAt: new Date("2026-08-02T13:00:01.000Z"),
  };
  const window = diaryInteractionWindow(row);
  assert.equal(window.start.toISOString(), "2026-08-01T13:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-08-02T13:00:00.000Z");
});

test("mood points fall into the same diary day as the 22:00 diary window", () => {
  const tokyo = "Asia/Tokyo";
  // 2026-08-02 の日記の窓は JST 8/1 22:00 の直後〜8/2 22:00（上のテストと同じ境界）。
  assert.equal(moodDiaryDate(new Date("2026-08-01T13:00:00.000Z"), tokyo), "2026-08-01");
  assert.equal(moodDiaryDate(new Date("2026-08-01T13:00:00.001Z"), tokyo), "2026-08-02");
  assert.equal(moodDiaryDate(new Date("2026-08-02T03:00:00.000Z"), tokyo), "2026-08-02");
  assert.equal(moodDiaryDate(new Date("2026-08-02T13:00:00.000Z"), tokyo), "2026-08-02");
  // 月・年をまたぐ繰り上がり。
  assert.equal(moodDiaryDate(new Date("2026-12-31T14:30:00.000Z"), tokyo), "2027-01-01");
  // 夏時間のある地域でも、ローカル22時で区切る（NY の夏は UTC-4）。
  const ny = "America/New_York";
  assert.equal(moodDiaryDate(new Date("2026-07-10T01:59:00.000Z"), ny), "2026-07-09");
  assert.equal(moodDiaryDate(new Date("2026-07-10T02:01:00.000Z"), ny), "2026-07-10");
});

test("ranks interaction targets by count, recency, then DID", () => {
  const at = (minute: number) =>
    new Date(`2026-08-02T12:${String(minute).padStart(2, "0")}:00Z`);
  const events = [
    { targetDid: "did:plc:bob", eventAt: at(1) },
    { targetDid: "did:plc:bob", eventAt: at(2) },
    { targetDid: "did:plc:carol", eventAt: at(3) },
    { targetDid: "did:plc:carol", eventAt: at(4) },
    { targetDid: "did:plc:dave", eventAt: at(5) },
    { targetDid: "did:plc:erin", eventAt: at(5) },
    { targetDid: "did:plc:alice", eventAt: at(9) },
    { targetDid: "did:plc:outside", eventAt: new Date("2026-08-01T00:00:00Z") },
  ];
  assert.deepEqual(
    rankDiaryInteractionActors(
      events,
      {
        start: new Date("2026-08-02T12:00:00Z"),
        end: new Date("2026-08-02T13:00:00Z"),
      },
      "did:plc:alice",
    ),
    ["did:plc:carol", "did:plc:bob", "did:plc:dave", "did:plc:erin"],
  );
  const manyActors = Array.from({ length: 12 }, (_, index) => ({
    targetDid: `did:plc:actor-${String(index).padStart(2, "0")}`,
    eventAt: at(index),
  }));
  assert.equal(
    rankDiaryInteractionActors(
      manyActors,
      {
        start: new Date("2026-08-02T12:00:00Z"),
        end: new Date("2026-08-02T13:00:00Z"),
      },
      "did:plc:alice",
    ).length,
    10,
  );
});
