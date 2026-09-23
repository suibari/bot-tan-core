import assert from "node:assert/strict";
import test, { after } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.BOT_MEMORY_TEST_DATABASE_URL;
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

const selection = (scope: { purpose: "scheduled_post" } | { purpose: "dj"; subjectDid: string }) => ({
  videoId: "video-1",
  songKey: "song-1",
  title: "Song",
  artist: "Artist",
  scope,
});

test("同一スコープの同時予約は1件だけ成功する", { skip: !databaseUrl }, async () => {
  await setup!`truncate affirmative_bot.bot_song_selections restart identity`;
  const now = new Date("2026-09-23T00:00:00.000Z");
  const results = await Promise.all([
    database!.reserveBotSongSelection(selection(database!.SCHEDULED_POST_SONG_SCOPE), { now }),
    database!.reserveBotSongSelection(selection(database!.SCHEDULED_POST_SONG_SCOPE), { now }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("DJ予約はDIDごとに分離する", { skip: !databaseUrl }, async () => {
  await setup!`truncate affirmative_bot.bot_song_selections restart identity`;
  const now = new Date("2026-09-23T00:00:00.000Z");
  const [alice, bob] = await Promise.all([
    database!.reserveBotSongSelection(selection(database!.djSongSelectionScope("did:plc:alice")), { now }),
    database!.reserveBotSongSelection(selection(database!.djSongSelectionScope("did:plc:bob")), { now }),
  ]);
  assert.ok(alice);
  assert.ok(bob);
});

test("予約は解放直後または15分失効後に取り直せる", { skip: !databaseUrl }, async () => {
  await setup!`truncate affirmative_bot.bot_song_selections restart identity`;
  const scope = database!.SCHEDULED_POST_SONG_SCOPE;
  const now = new Date("2026-09-23T00:00:00.000Z");
  const first = await database!.reserveBotSongSelection(selection(scope), { now });
  assert.ok(first);
  assert.equal(await database!.reserveBotSongSelection(selection(scope), {
    now: new Date(now.getTime() + 14 * 60_000),
  }), null);
  await database!.releaseBotSongSelection(first!);
  const afterRelease = await database!.reserveBotSongSelection(selection(scope), { now });
  assert.ok(afterRelease);

  const atExpiry = await database!.reserveBotSongSelection(selection(scope), {
    now: new Date(now.getTime() + 15 * 60_000),
  });
  assert.ok(atExpiry);
});

test("確定曲は30日ちょうどまで除外し、1ms後に再予約できる", { skip: !databaseUrl }, async () => {
  await setup!`truncate affirmative_bot.bot_song_selections restart identity`;
  const scope = database!.SCHEDULED_POST_SONG_SCOPE;
  const now = new Date("2026-08-01T00:00:00.000Z");
  const reservation = await database!.reserveBotSongSelection(selection(scope), { now });
  assert.ok(reservation);
  await database!.finalizeBotSongSelection(reservation!, "at://published");

  assert.equal(await database!.reserveBotSongSelection(selection(scope), {
    now: new Date("2026-08-31T00:00:00.000Z"),
  }), null);
  assert.ok(await database!.reserveBotSongSelection(selection(scope), {
    now: new Date("2026-08-31T00:00:00.001Z"),
  }));
});
