import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.BOT_MEMORY_TEST_DATABASE_URL;

test("migration-backed upsert, backfill, and reaction purge are idempotent", {
  skip: !databaseUrl,
}, async () => {
  const target = new URL(databaseUrl!);
  assert.equal(target.pathname, "/bot_memory_phase1_test");
  process.env.DATABASE_URL = databaseUrl;
  process.env.NAGI_BOT_DID = "did:plc:botmemorytest";

  const setup = postgres(databaseUrl!, { max: 1 });
  const database = await import("@bsky-affirmative-bot/database");
  const memory = database;
  const backfill = await import("../../../scripts/backfillBotMemory.js");

  try {
    await setup`create schema if not exists bottan_live`;
    await setup`create table if not exists bottan_live.comments
      (id serial primary key, broadcast_id text, author_channel_id text, comment text, reply text, energy_at integer, created_at timestamptz default now())`;
    await setup`create table if not exists bottan_live.broadcasts
      (id serial primary key, broadcast_id text unique, url text, title text,
       started_at timestamptz, ended_at timestamptz, comment_count integer default 0,
       created_at timestamptz default now(), scheduled_start_at timestamptz,
       scheduled_end_at timestamptz, prepared_at timestamptz)`;
    await setup`truncate
      affirmative_bot.bot_memory_usages,
      affirmative_bot.bot_memory_documents,
      affirmative_bot.subscribers,
      affirmative_bot.interaction,
      affirmative_bot.replies,
      affirmative_bot.biorhythm_history,
      nagi.reactions,
      nagi.bot_reply_jobs,
      nagi.posts,
      nagi.emojis
      restart identity cascade`;
    await setup`truncate bottan_live.comments restart identity`;
    await setup`truncate bottan_live.broadcasts restart identity`;

    const original = await memory.upsertBotMemoryDocument({
      sourceType: "bsky_received_reply",
      sourceId: "upsert-check",
      content: "同じ本文",
      occurredAt: new Date("2026-08-21T00:00:00Z"),
    });
    assert.ok(original);
    await setup.unsafe(
      `update affirmative_bot.bot_memory_documents set embedding = '${JSON.stringify(Array(1024).fill(0.1))}'::vector, embedding_model = 'test' where id = ${original!.id}`,
    );
    await memory.upsertBotMemoryDocument({
      sourceType: "bsky_received_reply",
      sourceId: "upsert-check",
      content: "同じ本文",
      occurredAt: new Date("2026-08-21T00:00:00Z"),
    });
    let state = await setup`select embedding is not null as embedded from affirmative_bot.bot_memory_documents where id = ${original!.id}`;
    assert.equal(state[0].embedded, true);
    await memory.upsertBotMemoryDocument({
      sourceType: "bsky_received_reply",
      sourceId: "upsert-check",
      content: "編集後の本文",
      occurredAt: new Date("2026-08-21T00:00:00Z"),
    });
    state = await setup`select embedding is null as cleared from affirmative_bot.bot_memory_documents where id = ${original!.id}`;
    assert.equal(state[0].cleared, true);
    await memory.tombstoneBotMemoryDocument("bsky_received_reply", "upsert-check");
    state = await setup`select deleted_at is not null as deleted from affirmative_bot.bot_memory_documents where id = ${original!.id}`;
    assert.equal(state[0].deleted, true);
    await setup`truncate affirmative_bot.bot_memory_usages, affirmative_bot.bot_memory_documents restart identity cascade`;

    await setup`insert into affirmative_bot.subscribers (did, status) values ('did:plc:subscriber', 'active')`;
    await setup`insert into affirmative_bot.interaction (type, did, details, created_at) values
      ('NormalReply', 'did:plc:subscriber', ${{ text: "購読者のAI対象", score: 91 }}, now()),
      ('NormalReply', 'did:plc:nonsubscriber', ${{ text: "非購読者のAI対象", score: 92 }}, now()),
      ('NormalReply', 'did:plc:subscriber', ${{ text: "定型文対象" }}, now()),
      ('like', 'did:plc:subscriber', ${{ text: "購読者がいいねしたbotたんの朝", uri: "at://did:plc:botmemorytest/app.bsky.feed.post/morning" }}, now()),
      ('like', 'did:plc:nonsubscriber', ${{ text: "非購読者がいいねしたbotたんの夜", uri: "at://did:plc:botmemorytest/app.bsky.feed.post/night" }}, now())`;
    await setup`insert into affirmative_bot.replies (did, reply, uri) values
      ('did:plc:reply-author', 'Blueskyで受けた返信', 'at://did:plc:reply-author/app.bsky.feed.post/reply')`;
    await setup`insert into affirmative_bot.biorhythm_history (status, mood, mood_en, energy) values
      ('Study', '検索について勉強した', 'Studied retrieval', 70)`;

    const publicAi = "at://did:plc:nagi-user/com.suibari.nagi.post/public-ai";
    const publicTemplate = "at://did:plc:nagi-user/com.suibari.nagi.post/public-template";
    const privateAi = "at://did:plc:nagi-user/com.suibari.nagi.post/private-ai";
    const receivedReply = "at://did:plc:nagi-user/com.suibari.nagi.post/reply";
    const botPost = "at://did:plc:botmemorytest/com.suibari.nagi.post/bot-post";
    for (const [uri, text, kossori] of [
      [publicAi, "Nagi公開AI対象", false],
      [publicTemplate, "Nagi定型文対象", false],
      [privateAi, "NagiこっそりAI対象", true],
      [receivedReply, "Nagiで受けた返信", false],
      [botPost, "botたんのお祝い投稿", false],
    ] as const) {
      await setup`insert into nagi.posts (uri, cid, rkey, did, text, record_created_at, kossori)
        values (${uri}, ${`cid-${text}`}, ${uri.split("/").at(-1)!}, ${uri === botPost ? process.env.NAGI_BOT_DID! : "did:plc:nagi-user"}, ${text}, now(), ${kossori})`;
    }
    for (const [uri, mode, reply] of [
      [publicAi, "ai", false],
      [publicTemplate, "template", false],
      [privateAi, "ai", false],
      [receivedReply, "template", true],
    ] as const) {
      const sourceText = uri === publicAi
        ? "Nagi公開AI対象"
        : uri === publicTemplate
          ? "Nagi定型文対象"
          : uri === privateAi
            ? "NagiこっそりAI対象"
            : "Nagiで受けた返信";
      await setup`insert into nagi.bot_reply_jobs
        (source_uri, source_cid, author_did, record_json, state, generation_mode, reply_uri)
        values (${uri}, 'source-cid', 'did:plc:nagi-user', ${{ text: sourceText, ...(reply ? { reply: { parent: { uri: botPost }, root: { uri: botPost } } } : {}) }}, 'posted', ${mode}, ${`${uri}-bot-reply`})`;
    }
    const emojiUri = "at://did:plc:emoji/blue.moji.collection.item/party";
    await setup`insert into nagi.emojis (uri, cid, did, name, alt, formats, created_at)
      values (${emojiUri}, 'emoji-cid', 'did:plc:emoji', ':party_blob:', '喜んで跳ねる猫', ${{ version: 1, asset: { kind: "blob", value: "cid", mediaType: "image/png" } }}, now())`;
    await setup`insert into nagi.reactions
      (uri, cid, did, subject_uri, emoji, emoji_uri, emoji_key, created_at)
      values ('at://did:plc:reactor/com.suibari.nagi.reaction/one', 'reaction-cid', 'did:plc:reactor', ${botPost}, ':party_blob:', ${emojiUri}, ${emojiUri}, now())`;
    await setup`insert into bottan_live.comments (broadcast_id, author_channel_id, comment, reply, energy_at)
      values ('broadcast', 'youtube-author', 'YouTubeのコメント', 'ありがとう', 50)`;
    await setup`insert into bottan_live.broadcasts
      (broadcast_id, url, title, scheduled_start_at, scheduled_end_at, prepared_at)
      values
      ('valid-live', 'https://www.youtube.com/watch?v=valid-live', '今日の配信',
       '2026-08-22T12:00:00Z', '2026-08-22T13:00:00Z', '2026-08-21T19:00:00Z'),
      ('invalid-live', 'https://example.com/watch?v=invalid', '不正URL',
       '2026-08-22T12:00:00Z', '2026-08-22T13:00:00Z', '2026-08-21T20:00:00Z'),
      ('ended-live', 'https://www.youtube.com/watch?v=ended-live', '終了済み',
       '2026-08-22T12:00:00Z', '2026-08-22T13:00:00Z', '2026-08-21T21:00:00Z')`;
    await setup`update bottan_live.broadcasts set ended_at = '2026-08-22T13:00:00Z'
      where broadcast_id = 'ended-live'`;

    const currentLive = await memory.MemoryService.getTodayYoutubeLiveBroadcast(
      new Date("2026-08-22T10:00:00Z"),
    );
    assert.equal(currentLive?.broadcastId, "valid-live");
    assert.equal(
      (await memory.MemoryService.getTodayYoutubeLiveBroadcast(
        new Date("2026-08-22T12:30:00Z"),
      ))?.broadcastId,
      "valid-live",
    );
    assert.equal(
      await memory.MemoryService.getTodayYoutubeLiveBroadcast(
        new Date("2026-08-22T12:50:00Z"),
      ),
      null,
    );

    const first = await backfill.runBotMemoryBackfill(true);
    const afterFirst = await setup`select count(*)::int as count from affirmative_bot.bot_memory_documents`;
    const second = await backfill.runBotMemoryBackfill(true);
    const afterSecond = await setup`select count(*)::int as count from affirmative_bot.bot_memory_documents`;
    assert.equal(first.total, second.total);
    assert.equal(afterFirst[0].count, afterSecond[0].count);

    const contents = await setup`select content from affirmative_bot.bot_memory_documents order by content`;
    const text = contents.map((row) => row.content).join("\n");
    assert.match(text, /購読者のAI対象/);
    assert.doesNotMatch(text, /非購読者のAI対象|定型文対象|こっそりAI対象/);
    assert.doesNotMatch(text, /購読者がいいねしたbotたんの朝|非購読者がいいねしたbotたんの夜/);
    assert.match(text, /Nagiで受けた返信/);
    assert.doesNotMatch(text, /喜んで跳ねる猫/);
    assert.match(text, /YouTubeのコメント/);

    const likeMemory = await memory.upsertBotMemoryDocument({
      sourceType: "bsky_received_like",
      sourceId: "legacy-like",
      content: "botたんの投稿へのいいね",
      occurredAt: new Date(),
    });
    const reactionMemory = await memory.upsertBotMemoryDocument({
      sourceType: "nagi_received_reaction",
      sourceId: "legacy-reaction",
      content: "botたんの投稿へのリアクション",
      occurredAt: new Date(),
    });
    assert.ok(likeMemory && reactionMemory);
    await memory.recordBotMemoryUsages(
      [likeMemory.id, reactionMemory.id],
      "live_filler",
    );

    const inactiveSearch = await memory.searchBotMemory({
      query: "botたんの投稿",
      purpose: "live_reply",
      sources: ["bsky_received_like", "nagi_received_reaction"],
    }, { embed: async () => null });
    assert.deepEqual(inactiveSearch, []);

    const dryRun = await memory.purgeReactionBotMemory(false);
    assert.equal(dryRun.deleted, 0);
    assert.equal(dryRun.before.reduce((sum, row) => sum + row.documents, 0), 2);
    assert.equal(dryRun.before.reduce((sum, row) => sum + row.usages, 0), 2);
    assert.equal((await memory.purgeReactionBotMemory(true)).deleted, 2);
    assert.equal((await memory.purgeReactionBotMemory(true)).deleted, 0);
    const remaining = await setup`
      select count(*)::int as count
      from affirmative_bot.bot_memory_documents
      where source_type in ('bsky_received_like', 'nagi_received_reaction')
    `;
    assert.equal(remaining[0].count, 0);

    // --- こっそりの可視範囲と印象語の書き分け ---
    // 印象語は日次予定表・定期ポスト・bot-tan.com へ流れるので、こっそりからは
    // 1件も作ってはいけない。判定は呼び出し側ではなくトランザクション内で行う。
    const kossoriDoc = await memory.upsertBotMemoryDocument({
      sourceType: "nagi_received_reply",
      sourceId: "kossori-one",
      sourceUri: "at://did:web:appview/com.suibari.nagi.post/kossori",
      authorId: "did:plc:teller",
      content: "『葬送のフリーレン』を見て泣いた",
      occurredAt: new Date(),
      visibility: "kossori",
    });
    assert.ok(kossoriDoc);
    assert.equal(kossoriDoc.visibility, "kossori");

    const savedKossori = await memory.saveBotMemoryImpressions(
      kossoriDoc.id,
      kossoriDoc.content_hash,
      [{ kind: "work", label: "葬送のフリーレン", relation: "discussed" }],
      92,
    );
    assert.equal(savedKossori, true);
    const kossoriImpressions = await setup`
      select count(*)::int as count from affirmative_bot.bot_memory_impressions
      where document_id = ${kossoriDoc.id}
    `;
    // 印象語は書かれない。
    assert.equal(kossoriImpressions[0].count, 0);
    const kossoriSalience = await setup`
      select salience from affirmative_bot.bot_memory_documents where id = ${kossoriDoc.id}
    `;
    // 印象度は書かれる（公開出力へ出ず、思い出の判定にしか使わないため）。
    assert.equal(kossoriSalience[0].salience, 92);

    // 公開の文書では従来どおり印象語が入る。
    const publicDoc = await memory.upsertBotMemoryDocument({
      sourceType: "nagi_received_reply",
      sourceId: "public-one",
      sourceUri: "at://did:plc:teller/com.suibari.nagi.post/public",
      authorId: "did:plc:teller",
      content: "『葬送のフリーレン』をおすすめしたい",
      occurredAt: new Date(),
    });
    assert.ok(publicDoc);
    assert.equal(publicDoc.visibility, "public");
    await memory.saveBotMemoryImpressions(
      publicDoc.id,
      publicDoc.content_hash,
      [{ kind: "work", label: "葬送のフリーレン", relation: "recommended" }],
      55,
    );
    const publicImpressions = await setup`
      select count(*)::int as count from affirmative_bot.bot_memory_impressions
      where document_id = ${publicDoc.id}
    `;
    assert.equal(publicImpressions[0].count, 1);

    // 通常の検索ではこっそりが1件も出ない。
    const publicSearch = await memory.searchBotMemory(
      { query: "葬送のフリーレン", purpose: "reply_history" },
      { embed: async () => null },
    );
    assert.ok(publicSearch.every((hit) => hit.id !== kossoriDoc.id));
    assert.ok(publicSearch.some((hit) => hit.id === publicDoc.id));

    // 本人のこっそり文脈でだけ出る。
    const kossoriSearch = await memory.searchBotMemory(
      {
        query: "葬送のフリーレン",
        purpose: "reply_history",
        kossoriSubjectKey: "did:plc:teller",
      },
      { embed: async () => null },
    );
    assert.ok(kossoriSearch.some((hit) => hit.id === kossoriDoc.id));

    // 別人のこっそり文脈では出ない。
    const otherSearch = await memory.searchBotMemory(
      {
        query: "葬送のフリーレン",
        purpose: "reply_history",
        kossoriSubjectKey: "did:plc:someone-else",
      },
      { embed: async () => null },
    );
    assert.ok(otherSearch.every((hit) => hit.id !== kossoriDoc.id));

    // author_id は名前空間の印付きで入る（YouTube のチャンネルIDと DID の同居対策）。
    const youtubeDoc = await memory.upsertBotMemoryDocument({
      sourceType: "youtube_live_comment",
      sourceId: "yt-one",
      authorId: "UCabc",
      content: "配信たのしい",
      occurredAt: new Date(),
    });
    assert.equal(youtubeDoc?.author_id, "youtube:UCabc");
  } finally {
    await backfill.closeBotMemoryBackfillDatabase();
    await database.client.end();
    await setup.end();
  }
});
