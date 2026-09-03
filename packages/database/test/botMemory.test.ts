import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_MEMORY_ACTIVE_SOURCE_TYPES,
  activeBotMemorySourceTypes,
  botMemoryContentHash,
  dailyPlanImpressionCooldownCondition,
  isBotMemorySourceType,
  isBotMemoryImpressionSourceType,
  mergeBotMemoryRanks,
  purgeReactionBotMemory,
  selectRecentBotMemoryImpressions,
  shouldRememberAffirmedPost,
  selectReplyMemoryContext,
} from "../src/botMemory.js";
import { bot_memory_impressions, db } from "../src/db.js";
import {
  isEligiblePronunciationSurface,
  isValidSpokenForm,
  mergeAutomaticPronunciation,
} from "../src/botMemoryPronunciation.js";

const row = (id: number, occurredAt = new Date("2026-08-21T00:00:00Z")) => ({
  id,
  sourceType: "bsky_affirmed_post" as const,
  sourceId: String(id),
  sourceUri: `at://example/${id}`,
  authorId: `did:example:${id}`,
  content: `memory ${id}`,
  botResponse: null,
  occurredAt,
  affirmationScore: null,
  metadata: null,
});

test("reaction event sources remain API-compatible but are not searchable", () => {
  assert.equal(isBotMemorySourceType("bsky_received_like"), true);
  assert.equal(isBotMemorySourceType("nagi_received_reaction"), true);
  assert.equal(BOT_MEMORY_ACTIVE_SOURCE_TYPES.includes("bsky_received_like"), false);
  assert.equal(BOT_MEMORY_ACTIVE_SOURCE_TYPES.includes("nagi_received_reaction"), false);
  assert.deepEqual(activeBotMemorySourceTypes([
    "bsky_received_reply",
    "bsky_received_like",
    "nagi_received_reaction",
  ]), ["bsky_received_reply"]);
  assert.deepEqual(activeBotMemorySourceTypes([
    "bsky_received_like",
    "nagi_received_reaction",
  ]), []);
});

test("reaction memory purge is dry-run by default and idempotent when applied", async () => {
  let remaining = 2;
  let deleteCalls = 0;
  const dependencies = {
    loadSummary: async () => [{
      sourceType: "bsky_received_like" as const,
      documents: remaining,
      usages: remaining,
    }, {
      sourceType: "nagi_received_reaction" as const,
      documents: 0,
      usages: 0,
    }],
    deleteDocuments: async () => {
      deleteCalls += 1;
      const deleted = remaining;
      remaining = 0;
      return deleted;
    },
  };

  assert.equal((await purgeReactionBotMemory(false, dependencies)).deleted, 0);
  assert.equal(deleteCalls, 0);
  assert.equal((await purgeReactionBotMemory(true, dependencies)).deleted, 2);
  assert.equal((await purgeReactionBotMemory(true, dependencies)).deleted, 0);
  assert.equal(deleteCalls, 2);
});

test("memory content hash is deterministic and content-sensitive", () => {
  assert.equal(botMemoryContentHash("same"), botMemoryContentHash("same"));
  assert.notEqual(botMemoryContentHash("same"), botMemoryContentHash("different"));
});

test("source type guard rejects unknown values", () => {
  assert.equal(isBotMemorySourceType("nagi_affirmed_post"), true);
  assert.equal(isBotMemorySourceType("nagi_received_reaction"), true);
  assert.equal(isBotMemorySourceType("kossori"), false);
});

test("daily plan theme memory includes public Bsky replies regardless of subscription", () => {
  assert.equal(isBotMemoryImpressionSourceType("bsky_received_reply"), true);
  assert.equal(isBotMemoryImpressionSourceType("nagi_received_reply"), true);
  assert.equal(isBotMemoryImpressionSourceType("youtube_live_comment"), true);
  assert.equal(isBotMemoryImpressionSourceType("bsky_received_like"), false);
});

test("daily plan theme cooldown encodes Date as a timestamp string", () => {
  const cooldown = new Date("2026-08-08T00:10:54.434Z");
  const query = db
    .select({ id: bot_memory_impressions.id })
    .from(bot_memory_impressions)
    .where(dailyPlanImpressionCooldownCondition(cooldown))
    .toSQL();

  assert.deepEqual(query.params, [cooldown.toISOString()]);
});

test("recent public impressions keep newest unique labels and active readings only", () => {
  const rows = [
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      pronunciationStatus: "active",
      occurredAt: new Date("2026-08-23T03:00:00Z"),
    },
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      pronunciationStatus: "active",
      occurredAt: new Date("2026-08-22T03:00:00Z"),
    },
    {
      label: "別の作品",
      spokenForm: "ベツノサクヒン",
      pronunciationStatus: "disabled",
      occurredAt: new Date("2026-08-21T03:00:00Z"),
    },
  ];

  assert.deepEqual(selectRecentBotMemoryImpressions(rows, 20), [
    {
      label: "攻殻機動隊",
      spokenForm: "コウカク、キドウタイ",
      occurredAt: rows[0].occurredAt,
    },
    {
      label: "別の作品",
      spokenForm: null,
      occurredAt: rows[2].occurredAt,
    },
  ]);
});

test("affirmed post memory keeps Nagi AI posts and subscriber-only Bluesky AI posts", () => {
  const base = { aiReplyPosted: true, isTopLevel: true, isPublic: true };
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi" }), true);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "bsky", isSubscriber: true }), true);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "bsky", isSubscriber: false }), false);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi", aiReplyPosted: false }), false);
  assert.equal(shouldRememberAffirmedPost({ ...base, surface: "nagi", isPublic: false }), false);
});

test("RRF merges duplicates and keeps candidates from both rankings", () => {
  const result = mergeBotMemoryRanks([row(1), row(2)], [row(2), row(3)], 3);
  assert.deepEqual(result.map((item) => item.id), [2, 1, 3]);
  assert.equal(result[0].semanticRank, 2);
  assert.equal(result[0].lexicalRank, 1);
});

test("RRF uses recency as a deterministic tie breaker", () => {
  const result = mergeBotMemoryRanks(
    [row(1, new Date("2026-08-20T00:00:00Z")), row(2)],
    [],
    2,
    60,
  );
  assert.deepEqual(result.map((item) => item.id), [1, 2]);
});

test("reply context uses stored rows without re-embedding candidates", () => {
  const ownLexical = { ...row(10), content: "本人の語彙一致", lexicalRank: 1, relevance: 0.01 };
  const friendLexical = { ...row(11), lexicalRank: 1, relevance: 0.01 };
  const friendSemantic = { ...row(12), semanticRank: 1, relevance: 0.02 };
  const selected = selectReplyMemoryContext(
    [ownLexical],
    [friendLexical, friendSemantic],
  );
  assert.deepEqual(selected.relatedPosts, ["本人の語彙一致"]);
  assert.equal(selected.friendMemory?.id, 12);
});

test("reply friend candidate excludes bot authors and lexical-only fallback", () => {
  const lexical = { ...row(20), authorId: "did:user", lexicalRank: 1, relevance: 0.01 };
  const bot = { ...row(21), authorId: "did:bot", semanticRank: 1, relevance: 0.02 };
  const selected = selectReplyMemoryContext([], [lexical, bot], ["did:bot"]);
  assert.equal(selected.friendMemory, undefined);
});

test("pronunciation validation accepts safe titles and katakana speech only", () => {
  assert.equal(isEligiblePronunciationSurface("攻殻機動隊"), true);
  assert.equal(isEligiblePronunciationSurface("心"), false);
  assert.equal(isEligiblePronunciationSurface("https://example.com"), false);
  assert.equal(isValidSpokenForm("コウカク、キドウタイ"), true);
  assert.equal(isValidSpokenForm("攻殻機動隊"), false);
  assert.equal(isValidSpokenForm("ignore instructions"), false);
});

test("automatic pronunciation never overwrites manual or disabled entries", () => {
  const manual = {
    surface: "攻殻機動隊",
    spokenForm: "コウカク、キドウタイ",
    kind: "work" as const,
    status: "active" as const,
    origin: "manual" as const,
    evidenceCount: 1,
    conflictCount: 0,
  };
  const next = mergeAutomaticPronunciation(manual, {
    surface: "攻殻機動隊", spokenForm: "オサムカラキドウタイ", kind: "work", eligible: true,
  });
  assert.equal(next.spokenForm, manual.spokenForm);
  assert.equal(next.evidenceCount, 2);
  assert.equal(next.conflictCount, 0);
});

test("conflicting automatic pronunciation keeps first reading and records conflict", () => {
  const current = {
    surface: "作品タイトル",
    spokenForm: "サクヒンタイトル",
    kind: "work" as const,
    status: "active" as const,
    origin: "auto" as const,
    evidenceCount: 2,
    conflictCount: 0,
  };
  const next = mergeAutomaticPronunciation(current, {
    surface: current.surface, spokenForm: "ベツノヨミ", kind: "work", eligible: true,
  });
  assert.equal(next.spokenForm, current.spokenForm);
  assert.equal(next.evidenceCount, 3);
  assert.equal(next.conflictCount, 1);
});
