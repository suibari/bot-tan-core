import assert from "node:assert/strict";
import test from "node:test";
import type { DailyPlanMemoryImpression } from "@bsky-affirmative-bot/database";
import {
  buildBotMemoryImpressionPrompt,
  buildMemoryImpressionsSection,
  parseBotMemoryImpressions,
  parseBotMemorySalience,
  processBotMemoryImpressionBatch,
  selectDailyMemoryImpressions,
} from "../src/botMemoryImpressions.js";

const documents = [{
  id: 10,
  sourceType: "nagi_received_reply" as const,
  content: "Nagiで『葬送のフリーレン』をおすすめしたい。https://example.com は見なくていい",
  contentHash: "hash",
  visibility: "public",
}];

test("原文にある安全な作品名だけを抽出する", () => {
  const parsed = parseBotMemoryImpressions({ items: [
    { documentId: 10, kind: "work", label: "『葬送のフリーレン』", relation: "recommended" },
    { documentId: 10, kind: "work", label: "存在しない作品", relation: "recommended" },
    { documentId: 10, kind: "word", label: "https://example.com", relation: "discussed" },
    { documentId: 999, kind: "word", label: "Nagi", relation: "discussed" },
  ] }, documents);

  assert.deepEqual(parsed.get(10), [{
    kind: "work",
    label: "葬送のフリーレン",
    relation: "recommended",
  }]);
});

test("抽出なしも空配列として返す", () => {
  assert.deepEqual(parseBotMemoryImpressions({ items: [] }, documents).get(10), []);
});

const candidates: DailyPlanMemoryImpression[] = [
  { id: 1, kind: "work", label: "作品A", relation: "recommended", source: "nagi", occurredAt: new Date() },
  { id: 2, kind: "word", label: "言葉B", relation: "discussed", source: "bsky", occurredAt: new Date() },
];

test("会話ネタは3日に1日は休み、同じ日には同じ候補になる", () => {
  const selections = ["2026-08-22", "2026-08-23", "2026-08-24"].map((date) =>
    selectDailyMemoryImpressions(candidates, date)
  );
  assert.equal(selections.filter((items) => items.length === 0).length, 1);
  assert.deepEqual(
    selectDailyMemoryImpressions(candidates, "2026-08-22"),
    selectDailyMemoryImpressions(candidates, "2026-08-22"),
  );
});

test("同じ語が複数媒体にあっても1日の候補では重複させない", () => {
  const selected = selectDailyMemoryImpressions([
    ...candidates,
    { ...candidates[0], id: 3, source: "youtube" },
  ], "2026-08-22");
  assert.equal(selected.filter((item) => item.label === "作品A").length, 1);
});

test("daily planには媒体だけを示し、投稿者情報を要求しない", () => {
  const section = buildMemoryImpressionsSection(candidates);
  assert.match(section, /Nagiでのやりとり/);
  assert.match(section, /Blueskyでのやりとり/);
  assert.match(section, /投稿者名・原文・URL・個人情報は書かない/);
  assert.match(section, /自然な1件だけ/);
});

test("抽出プロンプトは架空キャラクターを許可し実在人物と視聴者名を除外する", () => {
  const prompt = buildBotMemoryImpressionPrompt(documents);
  assert.match(prompt, /架空キャラクター名は抽出してよい/);
  assert.match(prompt, /実在人物名、視聴者名/);
});

test("kind の値や自分の名前は label として採らない", () => {
  // LLM は kind をそのまま label に書いてくることがある（実データに "work" と
  // "anime" が各16件入っていた）。予定表の候補として毎日流れてくるので弾く。
  const documents = [{
    id: 1,
    sourceType: "bsky_received_reply",
    content: "work と anime の話をしたよ。botたんもゲームが好きなんだね。",
    contentHash: "hash-1",
  }] as const;
  const parsed = parseBotMemoryImpressions({
    items: [
      { documentId: 1, kind: "work", label: "work", relation: "discussed" },
      { documentId: 1, kind: "word", label: "anime", relation: "discussed" },
      { documentId: 1, kind: "word", label: "botたん", relation: "discussed" },
    ],
  }, [...documents]);

  assert.deepEqual(parsed.get(1), []);
});

test("印象度は候補集合のIDだけを受け取り、範囲外は潰す", () => {
  const parsed = parseBotMemorySalience({
    salience: [
      { documentId: 10, score: 130 },
      // 渡していない document の ID を返してくることがある。無視する。
      { documentId: 999, score: 90 },
    ],
  }, documents);
  assert.equal(parsed.get(10), 100);
  assert.equal(parsed.has(999), false);
});

test("印象度が返ってこなかった document は未評価のまま", () => {
  const parsed = parseBotMemorySalience({ items: [] }, documents);
  assert.equal(parsed.has(10), false);
});

test("同じ document を二重に返してきても最初の1件だけ採る", () => {
  const parsed = parseBotMemorySalience({
    salience: [{ documentId: 10, score: 80 }, { documentId: 10, score: 10 }],
  }, documents);
  assert.equal(parsed.get(10), 80);
});

test("こっそりでも印象度は保存し、印象語は調査キューへ積まない", async () => {
  const kossori = [{
    id: 20,
    sourceType: "nagi_received_reply" as const,
    content: "『葬送のフリーレン』を見て泣いた",
    contentHash: "hash-kossori",
    visibility: "kossori",
  }];
  const saved: any[] = [];
  const enqueued: string[][] = [];
  const processed = await processBotMemoryImpressionBatch({
    enqueueLabels: (labels) => enqueued.push(labels),
    fetchPending: async () => kossori,
    generate: async () => ({
      text: JSON.stringify({
        items: [{
          documentId: 20, kind: "work",
          label: "葬送のフリーレン", relation: "discussed",
        }],
        salience: [{ documentId: 20, score: 92 }],
      }),
    }),
    save: async (id, hash, impressions, salience) => {
      saved.push({ id, hash, impressions, salience });
      return true;
    },
  });

  assert.equal(processed, 1);
  // 印象度は可視範囲に関係なく保存側へ渡す。
  assert.equal(saved[0].salience, 92);
  // 印象語そのものは渡すが、書くかどうかは saveBotMemoryImpressions が
  // トランザクション内で visibility を見て決める（ここでは落とさない）。
  assert.equal(saved[0].impressions.length, 1);
  // 調査キューへは積まない。調べた結果は web_research として公開記憶へ入り、
  // 定期ポストの根拠にもなるので、内緒話の語を流してはいけない。
  assert.deepEqual(enqueued, []);
});

test("公開の会話では印象語を調査キューへ積む", async () => {
  const enqueued: string[][] = [];
  await processBotMemoryImpressionBatch({
    enqueueLabels: (labels) => enqueued.push(labels),
    fetchPending: async () => documents,
    generate: async () => ({
      text: JSON.stringify({
        items: [{
          documentId: 10, kind: "work",
          label: "葬送のフリーレン", relation: "recommended",
        }],
        salience: [{ documentId: 10, score: 60 }],
      }),
    }),
    save: async () => true,
  });
  assert.deepEqual(enqueued, [["葬送のフリーレン"]]);
});
