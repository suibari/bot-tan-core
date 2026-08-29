import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUserDiaryContext,
  compactDiaryActivities,
  getDiaryObservances,
  preferredDiaryContextKind,
  selectDiaryObservances,
} from "../src/userDiaryContext.js";

test("consecutive duplicate activities are compressed and capped at eight", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    mood: index < 3 ? "sleep" : `activity-${index}`,
    mood_en: index < 3 ? "sleep" : `activity-${index}`,
    created_at: new Date(2026, 7, 10, index),
  }));
  const result = compactDiaryActivities(rows, new Date(2026, 7, 11));
  assert.equal(result.length, 8);
  assert.equal(result.filter((row) => row.mood === "sleep").length, 0);
  assert.equal(result.at(-1)?.mood, "activity-11");
});

test("observance sampling is deterministic, unique, and capped at eight", () => {
  const values = [...Array.from({ length: 12 }, (_, i) => `day-${i}`), "day-1"];
  const first = selectDiaryObservances(values, "did:plc:test", "2026-08-10");
  const second = selectDiaryObservances(values, "did:plc:test", "2026-08-10");
  assert.deepEqual(first, second);
  assert.equal(first.length, 8);
  assert.equal(new Set(first).size, 8);
});

test("日記も年付きの共通経路で可変記念日を判定する", () => {
  assert.equal(getDiaryObservances("2025-09-15").includes("敬老の日"), true);
  assert.equal(getDiaryObservances("2026-09-15").includes("敬老の日"), false);
  assert.equal(getDiaryObservances("2026-09-21").includes("敬老の日"), true);
  assert.equal(getDiaryObservances("2026-08-29").includes("プレミアムフライデー"), false);
});

test("不正な日記日付では記念日を返さない", () => {
  assert.deepEqual(getDiaryObservances("2026/09/21"), []);
});

test("preferred category is reproducible and rotates across dates", () => {
  const values = Array.from({ length: 14 }, (_, day) =>
    preferredDiaryContextKind("did:plc:test", `2026-08-${String(day + 1).padStart(2, "0")}`),
  );
  assert.equal(values[0], preferredDiaryContextKind("did:plc:test", "2026-08-01"));
  assert.ok(new Set(values).size > 1);
});

test("source failures degrade to an empty context without throwing", async () => {
  const warnings: unknown[][] = [];
  const result = await buildUserDiaryContext({
    did: "did:plc:test",
    date: "2026-08-10",
    since: new Date("2026-08-09T13:00:00Z"),
    until: new Date("2026-08-10T13:00:00Z"),
    timezone: "Asia/Tokyo",
    japanese: true,
    logger: { warn: (...args: unknown[]) => void warnings.push(args) },
    sources: {
      getActivities: async () => { throw new Error("activity unavailable"); },
      getNews: async () => { throw new Error("news unavailable"); },
      getObservances: () => { throw new Error("observance unavailable"); },
    },
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(warnings.length, 3);
});

test("builder applies all candidate limits and exposes no interaction data", async () => {
  const result = await buildUserDiaryContext({
    did: "did:plc:test",
    date: "2026-08-10",
    since: new Date("2026-08-09T13:00:00Z"),
    until: new Date("2026-08-10T13:00:00Z"),
    timezone: "Asia/Tokyo",
    japanese: true,
    sources: {
      getActivities: async () => Array.from({ length: 12 }, (_, i) => ({ mood: `m${i}`, mood_en: `m${i}`, created_at: new Date(2026, 7, 10, i) })),
      getNews: async () => Array.from({ length: 9 }, (_, i) => ({ titleJa: `news-${i}`, createdAt: new Date(2026, 7, 10, i) })),
      getObservances: () => Array.from({ length: 12 }, (_, i) => `day-${i}`),
    },
  });
  assert.equal(result.candidates.filter((item) => item.kind === "bot_activity").length, 8);
  assert.equal(result.candidates.filter((item) => item.kind === "observance").length, 8);
  assert.equal(result.candidates.filter((item) => item.kind === "news").length, 5);
  assert.doesNotMatch(JSON.stringify(result), /handle|displayName|conversation|reply/);
});
