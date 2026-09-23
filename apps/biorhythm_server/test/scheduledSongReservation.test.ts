import assert from "node:assert/strict";
import test from "node:test";
import type { ReservedMoodSong } from "@bsky-affirmative-bot/bot-brain";
import { SCHEDULED_POST_SONG_SCOPE } from "@bsky-affirmative-bot/database";
import { settleScheduledSongReservation } from "../src/ScheduledPostCoordinator.js";

const selectedAt = new Date("2026-09-23T00:00:00.000Z");
const reservedSong: ReservedMoodSong = {
  song: {
    title: "Song",
    artist: "Artist",
    comment: "Comment",
    songKey: "song",
    videoId: "video",
    url: "https://www.youtube.com/watch?v=video",
    videoTitle: "Song",
    channelTitle: "Artist",
  },
  reservation: {
    id: 1,
    videoId: "video",
    songKey: "song",
    scope: SCHEDULED_POST_SONG_SCOPE,
    selectedAt,
    expiresAt: new Date("2026-09-23T00:15:00.000Z"),
  },
};

for (const [target, results] of [
  ["Bluesky", { bsky: { uri: "at://bsky/post", cid: "bsky-cid" } }],
  ["Nagi", { nagi: { uri: "at://nagi/post", cid: "nagi-cid" } }],
] as const) {
  test(`${target}だけ成功してもfinalizeし、予約を解放しない`, async () => {
    const finalized: Array<string | undefined> = [];
    let released = 0;
    let remembered = 0;
    const published = await settleScheduledSongReservation(reservedSong, results, {
      finalize: async (_reservation, outputRef) => { finalized.push(outputRef); },
      release: async () => { released++; },
      remember: () => { remembered++; },
    });

    assert.equal(published, true);
    assert.deepEqual(finalized, [Object.values(results)[0].uri]);
    assert.equal(released, 0);
    assert.equal(remembered, 1);
  });
}

test("両方失敗した場合だけ予約を解放する", async () => {
  let finalized = 0;
  let released = 0;
  let remembered = 0;
  const published = await settleScheduledSongReservation(reservedSong, {}, {
    finalize: async () => { finalized++; },
    release: async () => { released++; },
    remember: () => { remembered++; },
  });

  assert.equal(published, false);
  assert.equal(finalized, 0);
  assert.equal(released, 1);
  assert.equal(remembered, 0);
});

test("両方成功してもfinalizeは一度だけ実行する", async () => {
  const outputRefs: Array<string | undefined> = [];
  let released = 0;
  const published = await settleScheduledSongReservation(reservedSong, {
    bsky: { uri: "at://bsky/post", cid: "bsky-cid" },
    nagi: { uri: "at://nagi/post", cid: "nagi-cid" },
  }, {
    finalize: async (_reservation, outputRef) => { outputRefs.push(outputRef); },
    release: async () => { released++; },
    remember: () => {},
  });

  assert.equal(published, true);
  assert.deepEqual(outputRefs, ["at://bsky/post"]);
  assert.equal(released, 0);
});

test("部分成功後にfinalizeが失敗しても成功扱いを維持し、予約を解放しない", async () => {
  let finalizeAttempts = 0;
  let released = 0;
  let remembered = 0;
  const errors: unknown[] = [];
  const published = await settleScheduledSongReservation(reservedSong, {
    nagi: { uri: "at://nagi/post", cid: "nagi-cid" },
  }, {
    finalize: async () => {
      finalizeAttempts++;
      throw new Error("database unavailable");
    },
    release: async () => { released++; },
    remember: () => { remembered++; },
    reportFinalizeError: (error) => { errors.push(error); },
  });

  assert.equal(published, true);
  assert.equal(finalizeAttempts, 3);
  assert.equal(released, 0);
  assert.equal(remembered, 1);
  assert.equal(errors.length, 1);
});
