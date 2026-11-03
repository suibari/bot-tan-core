import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_SITE_DOCUMENT,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { isNagiStandardDocument } from "../src/ingest/standardDocument.js";
import { validateRecord } from "../src/ingest/validateRecord.js";

const document = (overrides: Record<string, unknown> = {}) => ({
  $type: STANDARD_SITE_DOCUMENT,
  site: "at://did:plc:alice/site.standard.publication/3pub",
  path: "/blog/did:plc:alice/3doc",
  title: "長い記事",
  publishedAt: "2026-09-22T00:00:00.000Z",
  content: {
    $type: "at.markpub.markdown",
    text: { $type: "at.markpub.text", markdown: "あ".repeat(3001) },
  },
  ...overrides,
});

test("Nagi の standard.site 記事は通常投稿の3000文字上限を受けない", () => {
  assert.equal(validateRecord(STANDARD_SITE_DOCUMENT, document()), true);
});

test("参照先 publication の canonical URL で Nagi 記事を識別する", async () => {
  assert.equal(
    await isNagiStandardDocument(
      "did:plc:alice",
      "3doc",
      document(),
      async () => ({
        $type: "site.standard.publication",
        url: "https://nagi.suibari.com",
      }),
    ),
    true,
  );
  assert.equal(
    await isNagiStandardDocument(
      "did:plc:alice",
      "3doc",
      document(),
      async () => ({
        $type: "site.standard.publication",
        url: "https://example.com",
      }),
    ),
    false,
  );
});

test("ユーザーごとの publication.url と相対 path の記事も Nagi 記事として識別する", async () => {
  const publication = (url: string) => async () => ({
    $type: "site.standard.publication",
    url,
  });
  assert.equal(
    await isNagiStandardDocument(
      "did:plc:alice",
      "3doc",
      document({ path: "/3doc" }),
      publication("https://nagi.suibari.com/blog/did:plc:alice"),
    ),
    true,
  );
  // 他人の DID 用の url を指す publication は Nagi の記事として扱わない。
  assert.equal(
    await isNagiStandardDocument(
      "did:plc:alice",
      "3doc",
      document({ path: "/3doc" }),
      publication("https://nagi.suibari.com/blog/did:plc:bob"),
    ),
    false,
  );
});

test("記事は本文に画像を置けるので、画像の枚数を4枚に絞らない", () => {
  const image = {
    image: {
      $type: "blob",
      ref: { $link: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" },
      mimeType: "image/webp",
      size: 100,
    },
    alt: "",
  };
  const embed = { $type: "com.suibari.nagi.post#images", images: Array(6).fill(image) };
  assert.equal(
    validateRecord(STANDARD_SITE_DOCUMENT, document({ nagi: { embed } })),
    true,
  );
  assert.equal(
    validateRecord("com.suibari.nagi.post", {
      $type: "com.suibari.nagi.post",
      text: "通常投稿",
      createdAt: "2026-09-22T00:00:00.000Z",
      embed,
    }),
    false,
  );
});
