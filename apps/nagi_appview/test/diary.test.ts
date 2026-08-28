import assert from "node:assert/strict";
import test from "node:test";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";
import {
  diaryInteractionWindow,
  diaryView,
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

test("diary view exposes involved actors only to the diary owner", () => {
  const base = {
    uri: "at://did:plc:bot/com.suibari.nagi.diary/alice-2026-08-02",
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

  assert.deepEqual(
    diaryView({ ...base, emoji: null, postCount: null }, undefined),
    {
      uri: base.uri,
      cid: base.cid,
      subject: base.subjectDid,
      date: base.diaryDate,
      text: base.text,
      titleJa: undefined,
      titleEn: undefined,
      postCount: undefined,
      isPrivate: undefined,
      involvedActors: undefined,
      involvedActorsHasMore: undefined,
      langs: undefined,
      createdAt: base.recordCreatedAt.toISOString(),
      indexedAt: base.indexedAt.toISOString(),
    },
  );

  const involved = [{ did: "did:plc:bob", handle: "bob.test" }];
  const hiddenView = diaryView(
    { ...base, emoji: "🍜🚃🎸", postCount: 4 },
    undefined,
    involved,
  );
  assert.equal(hiddenView.postCount, 4);
  assert.equal(hiddenView.involvedActors, undefined);
  assert.equal(hiddenView.involvedActorsHasMore, undefined);

  const view = diaryView(
    { ...base, emoji: "🍜🚃🎸", postCount: 4 },
    base.subjectDid,
    involved,
  );
  assert.equal(view.postCount, 4);
  assert.deepEqual(view.involvedActors, involved);
  assert.equal(view.involvedActorsHasMore, undefined);
  assert.equal(
    diaryView(
      { ...base, emoji: null, postCount: 4 },
      base.subjectDid,
      involved,
      true,
    ).involvedActorsHasMore,
    true,
  );
  assert.equal("emoji" in view, false);
});

test("private diaries keep the graph cell but hide the body from everyone else", () => {
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
  const involved = [{ did: "did:plc:bob", handle: "bob.test" }];

  // 本人。中身は普通に読める。
  const mine = diaryView(row, "did:plc:alice", involved);
  assert.equal(mine.text, row.text);
  assert.equal(mine.titleJa, "今日の称号");
  assert.deepEqual(mine.involvedActors, involved);
  assert.equal(mine.isPrivate, true);
  assert.equal(mine.bodyHidden, undefined);

  // 他人と未認証。日付と件数だけ（コミットグラフの濃淡は出したいので postCount は残す）。
  for (const viewer of ["did:plc:bob", undefined]) {
    const hidden = diaryView(row, viewer, involved, true);
    assert.equal(hidden.isPrivate, true);
    assert.equal(hidden.bodyHidden, true);
    assert.equal(hidden.date, row.diaryDate);
    assert.equal(hidden.postCount, 4);
    assert.equal(hidden.text, "");
    assert.equal(hidden.titleJa, undefined);
    assert.equal(hidden.titleEn, undefined);
    assert.equal(hidden.involvedActors, undefined);
    assert.equal(hidden.involvedActorsHasMore, undefined);
  }
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
