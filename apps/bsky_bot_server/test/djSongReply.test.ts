import assert from "node:assert/strict";
import test from "node:test";
import type { BlobRef } from "@atproto/api";
import { buildDjSongReply } from "../src/features/djSongReply.js";

const song = {
  title: "Song", artist: "Artist", songKey: "artist:song", comment: "Today's song!",
  songUrl: "https://www.last.fm/music/Artist/_/Song", url: "https://www.last.fm/music/Artist/_/Song",
  lastFmUrl: "https://www.last.fm/music/Artist/_/Song",
  thumbnailUrl: "https://lastfm-img.freetls.fastly.net/i/u/300x300/cover.png",
};

test("DJはLast.fmリンクとAPI由来ジャケットを外部カードへ添付する", async () => {
  const blob = { mimeType: "image/png" } as BlobRef;
  let downloaded = "";
  const reply = await buildDjSongReply(song, async (data, mimeType) => {
    assert.deepEqual([...data], [1, 2, 3]);
    assert.equal(mimeType, "image/png");
    return blob;
  }, async (url) => {
    downloaded = url;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
  });
  assert.equal(downloaded, song.thumbnailUrl);
  assert.notEqual(typeof reply, "string");
  if (typeof reply === "string") return;
  assert.equal(reply.external?.uri, song.url);
  assert.equal(reply.external?.thumb, blob);
  assert.match(reply.text, /Source: Last.fm/);
  assert.equal(reply.text.split(song.url).length - 1, 1);
  assert.doesNotMatch(reply.text, /youtube/i);
});

test("画像取得失敗・HTML・サイズ超過では誤ったサムネイルを投稿しない", async () => {
  const upload = async () => { throw new Error("must not upload"); };
  await assert.rejects(buildDjSongReply(song, upload, async () => new Response(null, { status: 404 })), /HTTP 404/);
  await assert.rejects(buildDjSongReply(song, upload, async () => new Response("html", { headers: { "content-type": "text/html" } })), /content type/);
  await assert.rejects(buildDjSongReply(song, upload, async () => new Response(new Uint8Array(1_000_001), { headers: { "content-type": "image/png" } })), /size limit/);
});
