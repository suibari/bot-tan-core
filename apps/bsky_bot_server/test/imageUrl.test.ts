import assert from "node:assert/strict";
import test from "node:test";
import { getImageUrl } from "../src/bsky/util.js";

test("画像なし投稿では PDS を解決しない", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.deepEqual(await getImageUrl("not-a-did", undefined), []);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});

test("リンクカード画像は PDS を解決せず Bluesky CDN を使う", async () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const images = await getImageUrl("not-a-did", {
      $type: "app.bsky.embed.external",
      external: {
        uri: "https://example.com",
        title: "example",
        description: "",
        thumb: {
          ref: { $link: "bafkreiexample" },
          mimeType: "image/jpeg",
        },
      },
    });
    assert.equal(images.length, 1);
    assert.match(images[0].image_url, /^https:\/\/cdn\.bsky\.app\//);
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});
