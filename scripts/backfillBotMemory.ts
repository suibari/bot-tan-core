import {
  db,
  client,
  upsertBotMemoryDocument,
  type BotMemoryDocumentInput,
} from "@bsky-affirmative-bot/database";
import { sql } from "drizzle-orm";
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";

dotenv.config();

const apply = process.argv.includes("--apply");

type Candidate = BotMemoryDocumentInput;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return [...await db.execute(query)] as T[];
}

export async function loadBotMemoryBackfillCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  const interactions = await rows<any>(sql`
    select id, type, did, details, created_at
    from affirmative_bot.interaction
    where type = 'NormalReply'
      and nullif(btrim(details->>'text'), '') is not null
      and details ? 'score'
      and exists (
        select 1 from affirmative_bot.subscribers s
        where s.did = interaction.did and s.status = 'active'
      )
    order by id
  `);
  for (const row of interactions) {
    candidates.push({
      sourceType: "bsky_affirmed_post",
      sourceId: `interaction:${row.id}`,
      authorId: row.did,
      content: row.details.text,
      occurredAt: new Date(row.created_at),
      affirmationScore: Number.isFinite(Number(row.details.score))
        ? Number(row.details.score)
        : null,
      metadata: { backfill: "interaction" },
    });
  }

  const nagi = await rows<any>(sql`
    select j.source_uri, j.author_did, j.record_json, j.reply_uri, j.score,
           j.generation_mode, j.created_at, p.kossori
    from nagi.bot_reply_jobs j
    join nagi.posts p on p.uri = j.source_uri
    where j.state = 'posted'
      and p.deleted_at is null
      and (j.record_json->'reply' is not null or j.generation_mode = 'ai')
      and nullif(btrim(j.record_json->>'text'), '') is not null
    order by j.created_at
  `);
  for (const row of nagi) {
    const record = row.record_json ?? {};
    candidates.push({
      sourceType: record.reply ? "nagi_received_reply" : "nagi_affirmed_post",
      sourceId: row.source_uri,
      sourceUri: row.source_uri,
      authorId: row.author_did,
      content: record.text,
      // こっそりも覚えるが、引ける範囲は visibility が持つ。
      visibility: row.kossori ? "kossori" : "public",
      occurredAt: new Date(record.createdAt ?? row.created_at),
      affirmationScore: row.score ?? null,
      metadata: {
        backfill: "nagi_bot_reply_jobs",
        replyUri: row.reply_uri,
        generationMode: row.generation_mode,
      },
    });
  }

  const biorhythm = await rows<any>(sql`
    select id, status, mood, mood_en, energy, created_at
    from affirmative_bot.biorhythm_history
    where nullif(btrim(mood), '') is not null
    order by id
  `);
  for (const row of biorhythm) {
    candidates.push({
      sourceType: "biorhythm",
      sourceId: String(row.id),
      content: row.mood,
      occurredAt: new Date(row.created_at),
      metadata: {
        backfill: "biorhythm_history",
        status: row.status,
        moodEn: row.mood_en,
        energy: row.energy,
      },
    });
  }

  try {
    const liveComments = await rows<any>(sql`
      select id, broadcast_id, author_channel_id, comment, reply, energy_at, created_at
      from bottan_live.comments
      where nullif(btrim(comment), '') is not null
      order by id
    `);
    for (const row of liveComments) {
      candidates.push({
        sourceType: "youtube_live_comment",
        sourceId: `legacy:${row.id}`,
        authorId: row.author_channel_id,
        content: row.comment,
        botResponse: row.reply,
        occurredAt: new Date(row.created_at),
        metadata: {
          backfill: "bottan_live.comments",
          broadcastId: row.broadcast_id,
          energy: row.energy_at,
        },
      });
    }
  } catch (error) {
    console.warn("[WARN][BOT_MEMORY_BACKFILL] bottan_live.comments is unavailable; skipping", error);
  }

  const latestReplies = await rows<any>(sql`
    select did, reply, uri, coalesce(updated_at, created_at) as occurred_at
    from affirmative_bot.replies
    where nullif(btrim(reply), '') is not null and uri is not null
  `);
  for (const row of latestReplies) {
    const nagiReply = String(row.uri).includes("/com.suibari.nagi.post/");
    candidates.push({
      sourceType: nagiReply ? "nagi_received_reply" : "bsky_received_reply",
      sourceId: row.uri,
      sourceUri: row.uri,
      authorId: row.did,
      content: row.reply,
      occurredAt: new Date(row.occurred_at),
      metadata: { backfill: "replies" },
    });
  }

  return candidates;
}

export async function runBotMemoryBackfill(shouldApply = false) {
  const candidates = await loadBotMemoryBackfillCandidates();
  const counts = candidates.reduce<Record<string, number>>((acc, item) => {
    acc[item.sourceType] = (acc[item.sourceType] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ mode: shouldApply ? "apply" : "dry-run", total: candidates.length, counts }, null, 2));
  let processed = 0;
  if (!shouldApply) return { total: candidates.length, counts, processed };

  for (const candidate of candidates) {
    await upsertBotMemoryDocument(candidate);
    processed++;
    if (processed % 500 === 0) console.log(`[BOT_MEMORY_BACKFILL] ${processed}/${candidates.length}`);
  }
  console.log(`[BOT_MEMORY_BACKFILL] completed ${processed} candidates`);
  return { total: candidates.length, counts, processed };
}

export async function closeBotMemoryBackfillDatabase() {
  await client.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void (async () => {
    try {
      await runBotMemoryBackfill(apply);
    } catch (error) {
      console.error("[BOT_MEMORY_BACKFILL] failed", error);
      process.exitCode = 1;
    } finally {
      await closeBotMemoryBackfillDatabase();
    }
  })();
}
