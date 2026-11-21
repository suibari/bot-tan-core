import assert from "node:assert/strict";
import test from "node:test";
import { blueskyPushTargets } from "../src/services/blueskyPushTargets.js";
import { buildBlueskyPushPayload } from "../src/services/pushPayload.js";

const ME = "did:plc:me";
const OTHER = "did:plc:other";
const mine = `at://${ME}/app.bsky.feed.post/mine`;
const isRecipient = (did: string) => did === ME;
const event = (collection: string, record: Record<string, unknown>, did = OTHER) => ({
  did,
  commit: { operation: "create", collection, rkey: "rk", record },
});

test("likes, reposts and follows go to the owner of the subject", () => {
  const like = blueskyPushTargets(event("app.bsky.feed.like", { subject: { uri: mine } }), isRecipient);
  assert.deepEqual(like.map((t) => [t.type, t.recipientDid, t.subjectUri, t.recordUri]), [
    ["blueskyLike", ME, mine, `at://${OTHER}/app.bsky.feed.like/rk`],
  ]);
  const repost = blueskyPushTargets(event("app.bsky.feed.repost", { subject: { uri: mine } }), isRecipient);
  assert.equal(repost[0].type, "blueskyRepost");
  const follow = blueskyPushTargets(event("app.bsky.graph.follow", { subject: ME }), isRecipient);
  assert.equal(follow[0].type, "blueskyFollow");
});

test("ignores people who have not turned on Bluesky push, and your own actions", () => {
  assert.deepEqual(
    blueskyPushTargets(event("app.bsky.feed.like", { subject: { uri: mine } }), () => false),
    [],
  );
  assert.deepEqual(
    blueskyPushTargets(event("app.bsky.feed.like", { subject: { uri: mine } }, ME), isRecipient),
    [],
  );
});

test("a post that replies, quotes and mentions you sends only one push", () => {
  const targets = blueskyPushTargets(
    event("app.bsky.feed.post", {
      text: "やあ",
      reply: { root: { uri: mine }, parent: { uri: mine } },
      embed: { $type: "app.bsky.embed.record", record: { uri: mine } },
      facets: [{ features: [{ $type: "app.bsky.richtext.facet#mention", did: ME }] }],
    }),
    isRecipient,
  );
  assert.deepEqual(targets.map((t) => t.type), ["blueskyReply"]);
  assert.equal(targets[0].post?.text, "やあ");
});

test("finds quotes inside recordWithMedia and keeps self labels", () => {
  const [target] = blueskyPushTargets(
    event("app.bsky.feed.post", {
      text: "",
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        record: { record: { uri: mine } },
        media: { $type: "app.bsky.embed.images", images: [] },
      },
      labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "porn" }] },
    }),
    isRecipient,
  );
  assert.equal(target.type, "blueskyQuote");
  assert.equal(target.post?.hasImages, true);
  assert.deepEqual(target.selfLabels, ["porn"]);
});

test("ignores updates and deletes", () => {
  assert.deepEqual(
    blueskyPushTargets(
      { did: OTHER, commit: { operation: "delete", collection: "app.bsky.feed.like", rkey: "rk" } },
      isRecipient,
    ),
    [],
  );
});

test("Bluesky payloads get a unique tag per event and open the Bluesky tab", () => {
  const payload = buildBlueskyPushPayload({
    type: "blueskyLike",
    recordUri: "at://did:plc:a/app.bsky.feed.like/1",
    actorName: "Aさん",
    body: "わたしの投稿",
  });
  assert.equal(payload.title, "AさんさんがBlueskyでいいねしました");
  assert.equal(payload.tag, "blueskyLike-at://did:plc:a/app.bsky.feed.like/1");
  assert.equal(payload.url, "/notifications?tab=bluesky");
  assert.equal(payload.body, "わたしの投稿");
});
