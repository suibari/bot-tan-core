import assert from "node:assert/strict";
import test from "node:test";
import { blobVideoToImageRefs } from "../src/media.js";

test("動画はサムネイル1枚の画像として渡す", () => {
  assert.deepEqual(
    blobVideoToImageRefs("did:plc:abc", { video: { ref: { $link: "bafkreix" }, mimeType: "video/mp4" } }),
    [
      {
        image_url: "https://video.bsky.app/watch/did%3Aplc%3Aabc/bafkreix/thumbnail.jpg",
        mimeType: "image/jpeg",
      },
    ],
  );
  assert.deepEqual(blobVideoToImageRefs("did:plc:abc", undefined), []);
  assert.deepEqual(blobVideoToImageRefs("did:plc:abc", { video: { ref: { $link: "x" }, mimeType: "image/png" } }), []);
});
