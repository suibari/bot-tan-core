import assert from "node:assert/strict";
import test from "node:test";
import { toRadioTrack, unreadRadioSlot } from "../src/queries/radio.js";
import type { nagiRadioTracks } from "@bsky-affirmative-bot/database";

const row: typeof nagiRadioTracks.$inferSelect = {
  subjectDid: "did:plc:alice", slotKey: "2026-09-24-14", status: "ready",
  claimedAt: new Date(), title: "Song", artist: "Artist", commentJa: "今日の曲", commentEn: "Today's song",
  videoId: null, videoTitle: null, songUrl: "https://www.last.fm/music/Artist/_/Song",
  thumbnailUrl: "https://lastfm-img.freetls.fastly.net/i/u/300x300/album.png",
  sourceUrl: null, publishedAt: new Date("2026-09-24T05:00:00Z"),
};

test("動画IDなしの曲リンクを現在枠・履歴の共通形式で返す", () => {
  const track = toRadioTrack(row);
  assert.equal(track?.songUrl, row.songUrl);
  assert.equal(track?.thumbnailUrl, row.thumbnailUrl);
  assert.equal(track?.commentJa, row.commentJa);
  assert.equal(track?.commentEn, row.commentEn);
  assert.equal(track?.publishedAt, "2026-09-24T05:00:00.000Z");
  assert.ok(!("videoId" in track!));
});

test("移行前のYouTube履歴はリンクとサムネイルを補完する", () => {
  const track = toRadioTrack({ ...row, songUrl: null, thumbnailUrl: null, videoId: "dQw4w9WgXcQ" });
  assert.equal(track?.songUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(track?.thumbnailUrl, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
});

test("リンクまたは画像が未確定の新しい放送は返さない", () => {
  assert.equal(toRadioTrack({ ...row, songUrl: null }), null);
  assert.equal(toRadioTrack({ ...row, thumbnailUrl: null }), null);
});

test("未読枠は既読位置より新しい最新枠だけを返す", () => {
  assert.equal(unreadRadioSlot("2026-09-24-20", "2026-09-24-14"), "2026-09-24-20");
  assert.equal(unreadRadioSlot("2026-09-24-14", "2026-09-24-14"), undefined);
  assert.equal(unreadRadioSlot("2026-09-24-14", "2026-09-24-20"), undefined);
  assert.equal(unreadRadioSlot("2026-09-24-14", undefined), "2026-09-24-14");
});
