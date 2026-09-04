import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDigestPrompt,
  generateMemoryDailyDigest,
  pendingDigestDates,
  selectDigestHighlights,
} from "../src/botMemoryDigestWorker.js";
import type { BotMemorySearchResult } from "@bsky-affirmative-bot/database";

const document = (
  id: number,
  sourceType: BotMemorySearchResult["sourceType"],
  content = `できごと ${id}`,
): BotMemorySearchResult => ({
  id,
  sourceType,
  sourceId: String(id),
  sourceUri: null,
  authorId: `did:example:${id}`,
  content,
  botResponse: null,
  occurredAt: new Date("2026-08-21T01:00:00Z"),
  affirmationScore: null,
  metadata: null,
  relevance: 0,
});

test("selectDigestHighlights は媒体ごとに散らして拾う", () => {
  const documents = [
    document(1, "nagi_affirmed_post"),
    document(2, "nagi_affirmed_post"),
    document(3, "nagi_affirmed_post"),
    document(4, "nagi_affirmed_post"),
    document(5, "nagi_affirmed_post"),
    document(6, "nagi_affirmed_post"),
    document(7, "bsky_affirmed_post"),
    document(8, "youtube_live_comment"),
  ];
  const highlights = selectDigestHighlights(documents);
  assert.equal(highlights.length, 5);
  assert.deepEqual(
    [...new Set(highlights.map((item) => item.surface))].sort(),
    ["bsky", "nagi", "youtube"],
  );
});

test("selectDigestHighlights は素材が1媒体しか無くても詰まらない", () => {
  const highlights = selectDigestHighlights([
    document(1, "nagi_affirmed_post"),
    document(2, "nagi_affirmed_post"),
  ]);
  assert.deepEqual(highlights.map((item) => item.documentId), [1, 2]);
});

test("selectDigestHighlights は長い本文を切り詰める", () => {
  const [highlight] = selectDigestHighlights([
    document(1, "nagi_affirmed_post", "あ".repeat(500)),
  ]);
  assert.ok(highlight.excerpt.length <= 121);
  assert.ok(highlight.excerpt.endsWith("…"));
});

test("pendingDigestDates は当日を含めず、前日から古い順に並ぶ", () => {
  // JST 2026-08-21T09:00
  const dates = pendingDigestDates(new Date("2026-08-21T00:00:00Z"));
  assert.deepEqual(dates, ["2026-08-18", "2026-08-19", "2026-08-20"]);
});

test("generateMemoryDailyDigest は生成済みの日を作り直さない", async () => {
  let generated = 0;
  const created = await generateMemoryDailyDigest("2026-08-20", {
    fetchExisting: async () => ({
      digestDate: "2026-08-20",
      summaryJa: "もうある",
      highlights: [],
      sourceCount: 1,
    }),
    fetchDocuments: async () => {
      throw new Error("素材を読んではいけない");
    },
    generate: async () => {
      generated++;
      return { text: "x" };
    },
    save: async () => {},
  });
  assert.equal(created, false);
  assert.equal(generated, 0);
});

test("generateMemoryDailyDigest は素材が無い日を作らない", async () => {
  let generated = 0;
  const created = await generateMemoryDailyDigest("2026-08-20", {
    fetchExisting: async () => null,
    fetchDocuments: async () => [],
    generate: async () => {
      generated++;
      return { text: "x" };
    },
    save: async () => {},
  });
  assert.equal(created, false);
  assert.equal(generated, 0);
});

test("generateMemoryDailyDigest は空の要約を保存しない", async () => {
  let saved = 0;
  const created = await generateMemoryDailyDigest("2026-08-20", {
    fetchExisting: async () => null,
    fetchDocuments: async () => [document(1, "nagi_affirmed_post")],
    generate: async () => ({ text: "   " }),
    save: async () => {
      saved++;
    },
  });
  assert.equal(created, false);
  assert.equal(saved, 0);
});

test("generateMemoryDailyDigest は要約とハイライトを保存する", async () => {
  const saves: any[] = [];
  const created = await generateMemoryDailyDigest("2026-08-20", {
    fetchExisting: async () => null,
    fetchDocuments: async () => [
      document(1, "nagi_affirmed_post"),
      document(2, "youtube_live_comment"),
    ],
    generate: async () => ({ text: "  にぎやかな一日だった。  " }),
    save: async (input) => {
      saves.push(input);
    },
  });
  assert.equal(created, true);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].summaryJa, "にぎやかな一日だった。");
  assert.equal(saves[0].sourceCount, 2);
  assert.deepEqual(
    saves[0].highlights.map((item: any) => item.surface).sort(),
    ["nagi", "youtube"],
  );
});

test("buildDigestPrompt は資料を未信頼として渡し、個人特定情報を求めない", () => {
  const prompt = buildDigestPrompt("2026-08-20", [
    document(1, "nagi_affirmed_post", "きょうは楽しかった"),
  ]);
  assert.match(prompt, /未信頼の資料/);
  assert.match(prompt, /個人を特定する情報/);
  assert.match(prompt, /きょうは楽しかった/);
  // 作者は資料に載せない。
  assert.doesNotMatch(prompt, /did:example/);
});
