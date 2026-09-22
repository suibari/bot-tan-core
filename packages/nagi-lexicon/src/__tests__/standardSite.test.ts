import assert from "node:assert/strict";
import test from "node:test";
import {
  NAGI,
  NAGI_STANDARD_SITE_URL,
  STANDARD_SITE_DOCUMENT,
  isNagiStandardSitePublication,
  nagiPostFromStandardDocument,
  nagiStandardSitePublicationUri,
} from "../index.js";

const document = (overrides: Record<string, unknown> = {}) => ({
  $type: STANDARD_SITE_DOCUMENT,
  site: "at://did:plc:alice/site.standard.publication/3pub",
  path: "/blog/did:plc:alice/3doc",
  title: "記事",
  publishedAt: "2026-09-22T00:00:00.000Z",
  content: {
    $type: "at.markpub.markdown",
    text: { $type: "at.markpub.text", markdown: "本文" },
  },
  nagi: { botSilent: true, langs: ["ja"] },
  ...overrides,
});

test("standard.site 文書を投稿へ射影する", () => {
  const post = nagiPostFromStandardDocument(document());
  assert.equal(post?.$type, NAGI.post);
  assert.equal(post?.text, "本文");
  assert.equal(post?.article, true);
  assert.equal(post?.botSilent, true);

});

test("document の所有者・path・publication参照を検証する", () => {
  assert.equal(
    nagiStandardSitePublicationUri(document(), "did:plc:alice", "3doc"),
    "at://did:plc:alice/site.standard.publication/3pub",
  );
  assert.equal(
    nagiStandardSitePublicationUri(document(), "did:plc:bob", "3doc"),
    undefined,
  );
  assert.equal(
    nagiStandardSitePublicationUri(document(), "did:plc:alice", "other"),
    undefined,
  );
});

test("Nagi publication は canonical URL で識別する", () => {
  assert.equal(
    isNagiStandardSitePublication({
      $type: "site.standard.publication",
      url: `${NAGI_STANDARD_SITE_URL}/`,
    }),
    true,
  );
  assert.equal(
    isNagiStandardSitePublication({
      $type: "site.standard.publication",
      url: "https://example.com",
    }),
    false,
  );
});
