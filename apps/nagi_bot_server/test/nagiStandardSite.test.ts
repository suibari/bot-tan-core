import assert from "node:assert/strict";
import test from "node:test";
import { isNagiStandardDocument } from "../src/NagiStandardSite.js";

const document = {
  $type: "site.standard.document",
  site: "at://did:plc:alice/site.standard.publication/3pub",
  path: "/blog/did:plc:alice/3doc",
  title: "記事",
  publishedAt: "2026-09-22T00:00:00.000Z",
  content: {
    $type: "at.markpub.markdown",
    text: { $type: "at.markpub.text", markdown: "本文" },
  },
};

test("bot は Nagi publication を参照する document だけを処理する", async () => {
  assert.equal(
    await isNagiStandardDocument(
      "did:plc:alice",
      "3doc",
      document,
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
      document,
      async () => ({
        $type: "site.standard.publication",
        url: "https://other.example",
      }),
    ),
    false,
  );
});
