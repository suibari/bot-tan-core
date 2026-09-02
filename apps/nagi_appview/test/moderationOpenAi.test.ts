import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIModerator,
  PermanentModerationInputError,
} from "../src/services/moderation/openai.js";

type SentBody = {
  model: string;
  input: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

const withMockFetch = async (
  responses: Array<Record<string, number> | { status: number; body: string }>,
  run: (sent: SentBody[]) => Promise<void>,
) => {
  const originalFetch = globalThis.fetch;
  const sent: SentBody[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as SentBody);
    const response = responses.shift();
    assert.ok(response, "unexpected moderation request");
    if ("status" in response)
      return new Response(response.body, { status: response.status });
    return Response.json({ results: [{ category_scores: response }] });
  }) as typeof fetch;
  try {
    await run(sent);
    assert.equal(responses.length, 0, "not all mock responses were consumed");
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test("sends text-only input once", async () => {
  await withMockFetch([{ harassment: 0.1 }], async (sent) => {
    const scores = await new OpenAIModerator("test-key").evaluate({
      texts: [" hello ", "world"],
      imageUrls: [],
    });
    assert.deepEqual(scores, { harassment: 0.1 });
    assert.deepEqual(sent[0].input, [{ type: "text", text: "hello\nworld" }]);
  });
});

test("sends multiple images one at a time and merges maximum scores", async () => {
  await withMockFetch(
    [
      { harassment: 0.1, violence: 0.7 },
      { harassment: 0.8, violence: 0.2 },
      { harassment: 0.3, violence: 0.4 },
      { harassment: 0.2, violence: 0.6 },
    ],
    async (sent) => {
      const scores = await new OpenAIModerator("test-key").evaluate({
        texts: ["caption"],
        imageUrls: [
          "https://example.com/1.webp",
          "https://example.com/2.webp",
          "https://example.com/3.webp",
          "https://example.com/4.webp",
        ],
      });
      assert.deepEqual(scores, { harassment: 0.8, violence: 0.7 });
      assert.equal(sent.length, 4);
      assert.deepEqual(
        sent.map((body) => body.input),
        ["1.webp", "2.webp", "3.webp", "4.webp"].map((name) => [
          { type: "text", text: "caption" },
          {
            type: "image_url",
            image_url: { url: `https://example.com/${name}` },
          },
        ]),
      );
    },
  );
});

test("sends image-only input one image per request", async () => {
  await withMockFetch([{ sexual: 0.2 }, { sexual: 0.4 }], async (sent) => {
    const scores = await new OpenAIModerator("test-key").evaluate({
      texts: [],
      imageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
    });
    assert.deepEqual(scores, { sexual: 0.4 });
    assert.ok(sent.every((body) => body.input.length === 1));
    assert.ok(sent.every((body) => body.input[0].type === "image_url"));
  });
});

test("propagates a permanent error from an individual image", async () => {
  await withMockFetch(
    [{ violence: 0.1 }, { status: 400, body: "invalid image" }],
    async () => {
      await assert.rejects(
        new OpenAIModerator("test-key").evaluate({
          texts: ["caption"],
          imageUrls: ["https://example.com/1.webp", "https://example.com/2.webp"],
        }),
        (error: unknown) =>
          error instanceof PermanentModerationInputError && error.status === 400,
      );
    },
  );
});
