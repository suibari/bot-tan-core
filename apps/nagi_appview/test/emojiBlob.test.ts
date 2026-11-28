import assert from "node:assert/strict";
import test from "node:test";
import { readEmojiBlob } from "../src/util/emojiBlob.js";

const png = { kind: "blob", mediaType: "image/png", value: "bafkrei" } as const;
const lottie = { ...png, mediaType: "application/lottie+zip", maxBytes: 128_000 } as const;

test("reads emoji blobs with legacy rows and validates the Lottie container signature", async () => {
  const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
  assert.deepEqual(await readEmojiBlob(new Response(pngBytes), png), pngBytes);
  const signature = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
  assert.deepEqual(await readEmojiBlob(new Response(signature), lottie), signature);
  await assert.rejects(readEmojiBlob(new Response("invalid container"), lottie), /not a Lottie ZIP/);
});

test("enforces the emoji slot size without trusting Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body);
  await assert.rejects(
    readEmojiBlob(response, { ...png, maxBytes: 128_000 }),
    /exceeds its size limit/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    readEmojiBlob(new Response("", { headers: { "content-length": "1000001" } }), png),
    /exceeds its size limit/,
  );
});
