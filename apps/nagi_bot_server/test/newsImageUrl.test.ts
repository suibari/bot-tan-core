import assert from "node:assert/strict";
import test from "node:test";
import { httpsImageUrl, resolveNewsImageUrl } from "../src/newsImageUrl.js";

const silent = { warn: () => {} };

test("keeps the image url the feed already provided", async () => {
  let called = 0;
  const image = await resolveNewsImageUrl(
    { articleId: "a1", imageUrl: "https://example.com/og.jpg", link: "https://example.com/article" },
    { fetchMetadata: async () => (called++, { uri: "", title: "", image: "https://other.example/og.jpg" }) },
  );

  assert.equal(image, "https://example.com/og.jpg");
  assert.equal(called, 0);
});

test("falls back to the article OGP when the feed had no image", async () => {
  const image = await resolveNewsImageUrl(
    { articleId: "a2", imageUrl: undefined, link: "https://example.com/article" },
    {
      fetchMetadata: async (url) => {
        assert.equal(url, "https://example.com/article");
        return { uri: url, title: "記事", image: "https://example.com/og.jpg" };
      },
    },
  );

  assert.equal(image, "https://example.com/og.jpg");
});

test("keeps publishing when the OGP fetch fails", async () => {
  const image = await resolveNewsImageUrl(
    { articleId: "a3", imageUrl: undefined, link: "https://example.com/article" },
    { fetchMetadata: async () => { throw new Error("timeout"); }, logger: silent },
  );

  assert.equal(image, undefined);
});

test("drops non-https images from both the feed and the OGP", async () => {
  const fromFeed = await resolveNewsImageUrl(
    { articleId: "a4", imageUrl: "http://example.com/og.jpg", link: "https://example.com/article" },
    { fetchMetadata: async (url) => ({ uri: url, title: "記事", image: "http://example.com/og.jpg" }) },
  );

  assert.equal(fromFeed, undefined);
  assert.equal(httpsImageUrl("not a url"), undefined);
  assert.equal(httpsImageUrl(undefined), undefined);
});

test("skips the fetch when the candidate has no link", async () => {
  let called = 0;
  const image = await resolveNewsImageUrl(
    { articleId: "a5", imageUrl: undefined, link: undefined },
    { fetchMetadata: async () => (called++, { uri: "", title: "" }) },
  );

  assert.equal(image, undefined);
  assert.equal(called, 0);
});
