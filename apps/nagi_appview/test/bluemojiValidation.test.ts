import assert from "node:assert/strict";
import test from "node:test";
import { BLUEMOJI_ITEM, NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  normalizeBluemojiFormats,
  validateRecord,
} from "../src/ingest/validateRecord.js";

const blob = (mimeType: string, size = 100) => ({
  $type: "blob",
  ref: { $link: "bafyvalidcid" },
  mimeType,
  size,
});
const record = (formats: Record<string, unknown>, fallbackText = "◌") => ({
  $type: BLUEMOJI_ITEM,
  name: ":party:",
  createdAt: "2026-07-30T00:00:00.000Z",
  fallbackText,
  formats: { $type: `${BLUEMOJI_ITEM}#formats_v0`, ...formats },
});

test("accepts every pinned formats_v0 media representation", () => {
  const cases = [
    { lottie: { $bytes: Buffer.from("zip").toString("base64") } },
    { apng_128: { $bytes: Buffer.from("apng").toString("base64") } },
    { gif_128: blob("image/gif") },
    { webp_128: blob("image/webp") },
    { png_128: blob("image/png") },
    { png_128: blob("application/octet-stream") },
    { original: blob("image/svg+xml", 1_000_000) },
    { original: blob("application/lottie+zip", 1_000_000) },
  ];
  for (const formats of cases) {
    assert.equal(validateRecord(BLUEMOJI_ITEM, record(formats)), true);
    assert.ok(normalizeBluemojiFormats(record(formats).formats));
  }
});

test("indexes v1 renditions as PDS blobs with the v1 size limit", () => {
  for (const [slot, mediaType] of [
    ["lottie", "application/lottie+zip"],
    ["apng_128", "image/apng"],
    ["gif_128", "image/gif"],
    ["webp_128", "image/webp"],
    ["png_128", "image/png"],
  ] as const) {
    const v1 = (asset: unknown) =>
      record({ $type: `${BLUEMOJI_ITEM}#formats_v1`, [slot]: asset });
    const valid = v1(blob(mediaType, 128_000));
    assert.equal(validateRecord(BLUEMOJI_ITEM, valid), true);
    assert.deepEqual(normalizeBluemojiFormats(valid.formats)?.asset, {
      kind: "blob",
      mediaType,
      value: "bafyvalidcid",
    });
    assert.equal(validateRecord(BLUEMOJI_ITEM, v1(blob(mediaType, 128_001))), false);
    assert.equal(validateRecord(BLUEMOJI_ITEM, v1({ $bytes: "YQ==" })), false);
  }
  const mixed = record({
    $type: `${BLUEMOJI_ITEM}#formats_v1`,
    apng_128: blob("image/apng", 128_001),
    original: blob("image/apng", 1_000_000),
  });
  assert.equal(normalizeBluemojiFormats(mixed.formats)?.asset.mediaType, "image/apng");
  assert.equal(validateRecord(BLUEMOJI_ITEM, record({ gif_128: blob("image/gif", 262_144) })), true);
});

test("rejects invalid fallback text and copy URIs", () => {
  assert.equal(
    validateRecord(
      BLUEMOJI_ITEM,
      record({ png_128: blob("image/png") }, ":party:"),
    ),
    false,
  );
  assert.equal(
    validateRecord(BLUEMOJI_ITEM, {
      ...record({ png_128: blob("image/png") }),
      copyOf: "not-an-at-uri",
    }),
    false,
  );
});

test("uses the formats_v0 field for optimized blob media type and rejects invalid limits", () => {
  assert.equal(
    validateRecord(BLUEMOJI_ITEM, record({ png_128: blob("image/gif") })),
    true,
  );
  assert.equal(
    normalizeBluemojiFormats(record({ png_128: blob("image/gif") }).formats)
      ?.asset.mediaType,
    "image/png",
  );
  assert.equal(
    validateRecord(BLUEMOJI_ITEM, record({ png_128: blob("", 100) })),
    false,
  );
  assert.equal(
    validateRecord(
      BLUEMOJI_ITEM,
      record({ original: blob("image/png", 1_000_001) }),
    ),
    false,
  );
  assert.equal(
    validateRecord(
      BLUEMOJI_ITEM,
      record({ lottie: { $bytes: Buffer.alloc(65_537).toString("base64") } }),
    ),
    false,
  );
  assert.equal(
    validateRecord(
      BLUEMOJI_ITEM,
      record({ apng_128: { $bytes: "not base64" } }),
    ),
    false,
  );
});

const postWithEmoji = (name = ":party:", cid = "bafyemoji") => ({
  $type: NAGI.post,
  text: `hello ${name}`,
  createdAt: "2026-08-01T00:00:00.000Z",
  facets: [
    {
      index: { byteStart: 6, byteEnd: 6 + Buffer.byteLength(name) },
      features: [
        {
          $type: "blue.moji.richtext.facet",
          did: "did:plc:emoji",
          name,
          formats: {
            $type: "blue.moji.richtext.facet#formats_v0",
            png_128: "bafyasset",
          },
        },
        {
          $type: "com.suibari.nagi.richtext#bluemoji",
          ref: {
            uri: `at://did:plc:emoji/${BLUEMOJI_ITEM}/party`,
            cid,
          },
          did: "did:plc:emoji",
          name,
          mediaType: "image/png",
        },
      ],
    },
  ],
});

test("accepts paired Bluemoji richtext facets and rejects mismatched aliases", () => {
  assert.equal(validateRecord(NAGI.post, postWithEmoji()), true);
  const mismatched = postWithEmoji(":party:");
  mismatched.facets[0].features[0].name = ":other:";
  assert.equal(validateRecord(NAGI.post, mismatched), false);
});
