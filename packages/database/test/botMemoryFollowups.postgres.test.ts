import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.BOT_MEMORY_TEST_DATABASE_URL;

/**
 * 予定の保存と取り出しを、Drizzle と postgres.js の実ドライバ境界ごと通す。
 * timestamp 列の比較（due_at と now）は型付き演算子で書いているが、それが
 * 実際に Date のまま送られていないことは、ここを通さないと分からない（AGENTS.md）。
 */
test("予定は公開文書からだけ作られ、期日を過ぎたら一度だけ取り出せる", {
  skip: !databaseUrl,
}, async () => {
  const target = new URL(databaseUrl!);
  assert.equal(target.pathname, "/bot_memory_phase1_test");
  process.env.DATABASE_URL = databaseUrl;

  const setup = postgres(databaseUrl!, { max: 1 });
  const memory = await import("@bsky-affirmative-bot/database");

  try {
    await setup`truncate
      affirmative_bot.bot_memory_followups,
      affirmative_bot.bot_memory_documents
      restart identity cascade`;

    const occurredAt = new Date("2026-10-20T00:00:00Z");
    const insert = (sourceId: string, visibility: "public" | "kossori", sourceType: any = "nagi_affirmed_post") =>
      memory.upsertBotMemoryDocument({
        sourceType,
        sourceId,
        authorId: "did:plc:planner",
        content: `${sourceId} 明日EO5-5を終わらせたい`,
        occurredAt,
        visibility,
      });
    const publicDoc = await insert("public", "public");
    const kossoriDoc = await insert("kossori", "kossori");
    const youtubeDoc = await insert("youtube", "public", "youtube_live_comment");
    assert.ok(publicDoc && kossoriDoc && youtubeDoc);

    const plan = { text: "EO5-5をクリアする", due: "tomorrow" as const };
    for (const doc of [publicDoc!, kossoriDoc!, youtubeDoc!]) {
      assert.equal(
        await memory.saveBotMemoryImpressions(doc.id, doc.content_hash, [], 40, plan),
        true,
      );
    }
    const rows = await setup`select document_id, due_at from affirmative_bot.bot_memory_followups`;
    assert.deepEqual(rows.map((row) => row.document_id), [publicDoc!.id]);
    assert.equal(new Date(rows[0].due_at).toISOString(), "2026-10-21T00:00:00.000Z");

    // 期日前は出さない
    assert.equal(
      await memory.takeDueFollowUp("did:plc:planner", new Date("2026-10-20T12:00:00Z")),
      undefined,
    );
    // 期日を過ぎたら1件
    const taken = await memory.takeDueFollowUp("did:plc:planner", new Date("2026-10-21T12:00:00Z"));
    assert.equal(taken?.text, "EO5-5をクリアする");
    assert.equal(taken?.occurredAt.toISOString(), occurredAt.toISOString());
    // 二度は出さない
    assert.equal(
      await memory.takeDueFollowUp("did:plc:planner", new Date("2026-10-21T13:00:00Z")),
      undefined,
    );
    // 再走査しても、聞き返し済みの予定は作り直さない
    await memory.saveBotMemoryImpressions(publicDoc!.id, publicDoc!.content_hash, [], 40, plan);
    const [{ count }] = await setup`select count(*)::int as count from affirmative_bot.bot_memory_followups`;
    assert.equal(count, 1);

    // 期日から7日を過ぎたものは出さない
    const stale = await insert("stale", "public");
    await memory.saveBotMemoryImpressions(stale!.id, stale!.content_hash, [], 40, plan);
    assert.equal(
      await memory.takeDueFollowUp("did:plc:planner", new Date("2026-10-29T00:00:00Z")),
      undefined,
    );
  } finally {
    await setup.end();
  }
});

test("朝の質問の答えは並んで届いても取りこぼさずに積まれる", {
  skip: !databaseUrl,
}, async () => {
  process.env.DATABASE_URL = databaseUrl;
  const setup = postgres(databaseUrl!, { max: 1 });
  const database = await import("@bsky-affirmative-bot/database");
  try {
    await setup`delete from affirmative_bot.bot_state where key = ${database.QUESTION_ANSWER_SUMMARIES_KEY}`;
    // 配列でない値が残っていても配列として積み直す
    await database.MemoryService.setBotState(database.QUESTION_ANSWER_SUMMARIES_KEY, "broken");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => database.MemoryService.appendQuestionAnswerSummary(`答え${i}`)),
    );
    const { summaries } = await database.MemoryService.getQuestionAnswerSummaries();
    assert.ok(Array.isArray(summaries));
    assert.equal((summaries as string[]).length, 10);

    await database.MemoryService.clearQuestionAnswerSummaries();
    assert.deepEqual((await database.MemoryService.getQuestionAnswerSummaries()).summaries, []);
  } finally {
    await setup.end();
  }
});

// 2つのテストで同じ接続を使うので、閉じるのは最後に1回だけ。
test.after(async () => {
  if (!databaseUrl) return;
  const database = await import("@bsky-affirmative-bot/database");
  await database.client.end();
});
