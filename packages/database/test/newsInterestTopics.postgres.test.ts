import assert from "node:assert/strict";
import test, { after } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.BOT_MEMORY_TEST_DATABASE_URL;

/**
 * 関心ジャンルの集計と配布を、Drizzle と postgres.js の実ドライバ境界越しに確かめる。
 *
 * 日時の絞り込みがあるので `.toSQL()` だけでは足りない（AGENTS.md「Database timestamp
 * parameters」）。Date が timestamp 列のエンコーダを通らないと、送信時に
 * ERR_INVALID_ARG_TYPE で落ちる。それはここでしか捕まらない。
 *
 * postgres テストは直列に走らせること（package.json の test は --test-concurrency=1）。
 * このファイルは他の postgres テストと同じDBを truncate する。
 */
if (databaseUrl) {
  assert.equal(new URL(databaseUrl).pathname, "/bot_memory_phase1_test");
  process.env.DATABASE_URL = databaseUrl;
}

const setup = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null;
const database = databaseUrl ? await import("@bsky-affirmative-bot/database") : null;

after(async () => {
  await database?.client.end();
  await setup?.end();
});

async function insertImpression(options: {
  sourceId: string;
  label: string;
  relation: "recommended" | "liked" | "discussed";
  visibility?: "public" | "kossori";
  occurredAt?: string;
  staleScan?: boolean;
  deleted?: boolean;
}) {
  const hash = `hash-${options.sourceId}`;
  const [document] = await setup!`
    insert into affirmative_bot.bot_memory_documents
      (source_type, source_id, content, visibility, occurred_at, content_hash, deleted_at)
    values ('bsky_received_reply', ${options.sourceId}, ${options.label},
            ${options.visibility ?? "public"},
            ${options.occurredAt ?? new Date().toISOString()}::timestamptz, ${hash},
            ${options.deleted ? new Date().toISOString() : null}::timestamptz)
    returning id`;
  await setup!`
    insert into affirmative_bot.bot_memory_impressions (document_id, kind, label, relation)
    values (${document.id}, 'work', ${options.label}, ${options.relation})`;
  await setup!`
    insert into affirmative_bot.bot_memory_impression_scans (document_id, content_hash)
    values (${document.id}, ${options.staleScan ? "stale-hash" : hash})`;
  return document.id as number;
}

test("印象語は label 単位に畳み、公開かつ窓内のものだけを数える", {
  skip: !databaseUrl,
}, async () => {
  await setup!`truncate affirmative_bot.bot_memory_documents restart identity cascade`;

  // 同じ作品名が2回出てくる。畳まないと1作品が上位を埋めてジャンルが1つしか出ない。
  await insertImpression({ sourceId: "d1", label: "作品タイトルA", relation: "recommended" });
  await insertImpression({ sourceId: "d2", label: "作品タイトルA", relation: "liked" });
  await insertImpression({ sourceId: "d3", label: "ラーメン", relation: "discussed" });
  // 数えてはいけないもの。
  await insertImpression({ sourceId: "d4", label: "ひみつの話", relation: "liked", visibility: "kossori" });
  await insertImpression({ sourceId: "d5", label: "抽出後に書き換わった", relation: "liked", staleScan: true });
  await insertImpression({ sourceId: "d6", label: "消された会話", relation: "liked", deleted: true });
  await insertImpression({
    sourceId: "d7",
    label: "去年の話",
    relation: "recommended",
    occurredAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const labels = await database!.loadBotMemoryInterestLabels({ now: new Date() });
  assert.deepEqual(labels, [
    { label: "作品タイトルA", weight: 5 },
    { label: "ラーメン", weight: 1 },
  ]);
});

test("ジャンルは総入れ替えしても last_used_at を持ち越す", {
  skip: !databaseUrl,
}, async () => {
  await setup!`truncate nagi.news_interest_topics`;
  const now = new Date("2026-09-12T00:00:00Z");

  await database!.replaceNewsInterestTopics(
    [
      { topic: "アニメ", score: 9, labelCount: 4 },
      { topic: "ゲーム", score: 5, labelCount: 2 },
      { topic: "猫", score: 1, labelCount: 1 },
    ],
    now,
  );

  // スコア最上位から配り、配ったものはクールダウンに入る。
  const first = await database!.pickNewsInterestTopic({ now });
  assert.equal(first?.topic, "アニメ");
  const second = await database!.pickNewsInterestTopic({ now });
  assert.equal(second?.topic, "ゲーム");

  // 入れ替えても「最近使った」は消さない。消すと最上位だけを引き続けて回らなくなる。
  await database!.replaceNewsInterestTopics(
    [
      { topic: "アニメ", score: 12, labelCount: 6 },
      { topic: "ゲーム", score: 5, labelCount: 2 },
      { topic: "猫", score: 1, labelCount: 1 },
    ],
    new Date(now.getTime() + 60_000),
  );
  const third = await database!.pickNewsInterestTopic({ now: new Date(now.getTime() + 60_000) });
  assert.equal(third?.topic, "猫");

  // 全ジャンルがクールダウン中なら配らない＝従来どおりの無指定取得へ落ちる。
  assert.equal(
    await database!.pickNewsInterestTopic({ now: new Date(now.getTime() + 120_000) }),
    undefined,
  );

  // クールダウンが明ければ、またスコア順に戻る。
  const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  assert.equal((await database!.pickNewsInterestTopic({ now: later }))?.topic, "アニメ");

  // 入れ替えで消えたジャンルは残さない。
  await database!.replaceNewsInterestTopics([{ topic: "猫", score: 3, labelCount: 2 }], later);
  const rows = await setup!`select topic from nagi.news_interest_topics order by topic`;
  assert.deepEqual(rows.map((row) => row.topic), ["猫"]);

  await database!.recordNewsInterestTopicYield("猫", 2);
  const [yieldRow] = await setup!`
    select last_accepted_count from nagi.news_interest_topics where topic = '猫'`;
  assert.equal(yieldRow.last_accepted_count, 2);
});
