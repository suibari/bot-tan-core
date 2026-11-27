import assert from "node:assert/strict";
import dns from "node:dns/promises";
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

test("bot は PLC で解決した PDS の publication を確認する", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "192.0.2.10", family: 4 }]);
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    if (url.hostname === "plc.directory")
      return Response.json({
        service: [{
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: "https://pds.example",
        }],
      });

    assert.equal(url.hostname, "pds.example");
    assert.equal(url.pathname, "/xrpc/com.atproto.repo.getRecord");
    assert.equal(url.searchParams.get("repo"), "did:plc:alice");
    assert.equal(url.searchParams.get("collection"), "site.standard.publication");
    assert.equal(url.searchParams.get("rkey"), "3pub");
    return Response.json({
      value: { $type: "site.standard.publication", url: "https://nagi.suibari.com" },
    });
  });

  assert.equal(await isNagiStandardDocument("did:plc:alice", "3doc", document), true);
  assert.equal(fetch.mock.callCount(), 2);
});
