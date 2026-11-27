import assert from "node:assert/strict";
import test from "node:test";
import { getNewsMetadata } from "../src/linkMetadata.js";
import { LinkMetadataError } from "../src/errors.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("extracts strict news metadata and resolves canonical fields", async () => {
  globalThis.fetch = async () =>
    new Response(
      `<html><head>
        <meta property="og:title" content="A bright story">
        <meta property="og:description" content="Good things happened">
        <meta property="og:site_name" content="Example News">
        <meta property="article:published_time" content="2026-08-01T12:30:00+09:00">
        <meta property="og:image" content="/image.jpg">
        <link rel="canonical" href="/canonical">
      </head></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );

  const value = await getNewsMetadata("https://93.184.216.34/article?utm_source=test");
  assert.equal(value.uri, "https://93.184.216.34/canonical");
  assert.equal(value.title, "A bright story");
  assert.equal(value.description, "Good things happened");
  assert.equal(value.siteName, "Example News");
  assert.equal(value.image, "https://93.184.216.34/image.jpg");
  assert.equal(value.publishedAt, "2026-08-01T03:30:00.000Z");
});

test("rejects a page when neither direct HTML nor fallback supplies a title", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("<html><head></head><body>no metadata</body></html>", {
          headers: { "content-type": "text/html" },
        })
      : new Response("{}", { status: 502, headers: { "content-type": "application/json" } });
  };

  await assert.rejects(
    () => getNewsMetadata("https://93.184.216.34/no-title"),
    (error: unknown) =>
      error instanceof LinkMetadataError &&
      error.status === 422 &&
      error.code === "metadata_unavailable",
  );
});

test("rejects private hosts before fetching", async () => {
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response();
  };
  await assert.rejects(
    () => getNewsMetadata("http://127.0.0.1/private"),
    (error: unknown) => error instanceof LinkMetadataError && error.code === "invalid_request",
  );
  assert.equal(fetched, false);
});

test("rejects non-HTML content without accepting a card fallback", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
  };
  await assert.rejects(
    () => getNewsMetadata("https://93.184.216.34/file.pdf"),
    (error: unknown) =>
      error instanceof LinkMetadataError && error.status === 415,
  );
  assert.equal(calls, 1);
});

test("revalidates redirect targets and blocks redirects to private hosts", async () => {
  globalThis.fetch = async () =>
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  await assert.rejects(
    () => getNewsMetadata("https://93.184.216.34/redirect"),
    (error: unknown) => error instanceof LinkMetadataError && error.code === "invalid_request",
  );
});

test("resolves relative metadata against the final fetched page", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    if (url.pathname === "/article")
      return new Response(null, { status: 302, headers: { location: "/news/current.html" } });
    assert.equal(url.pathname, "/news/current.html");
    return new Response(
      '<title>Example News</title><meta property="og:image" content="cover.jpg">',
      { headers: { "content-type": "text/html" } },
    );
  };

  const value = await getNewsMetadata("https://192.0.2.10/article");
  assert.equal(value.uri, "https://192.0.2.10/news/current.html");
  assert.equal(value.image, "https://192.0.2.10/news/cover.jpg");
});
