import assert from "node:assert/strict";
import test from "node:test";
import { blueskyVideoUrls } from "../src/blueskyVideo.js";

test("video.bsky.app の再生 URL とサムネイル URL を作る", () => {
  assert.deepEqual(blueskyVideoUrls("did:plc:abc", "bafkreix"), {
    playlist: "https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkreix/playlist.m3u8",
    thumbnail: "https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkreix/thumbnail.jpg",
  });
});
