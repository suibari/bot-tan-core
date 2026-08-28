import assert from "node:assert/strict";
import test from "node:test";
import type { EmojiView } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  groupReactionViews,
  type ReactionViewRow,
} from "../src/queries/reactionViews.js";

const row = (
  did: string,
  overrides: Partial<ReactionViewRow> = {},
): ReactionViewRow => ({
  subjectUri: "at://did:example:bot/com.suibari.nagi.news/news-1",
  emoji: "🎉",
  emojiKey: "🎉",
  emojiUri: null,
  subjectDid: "did:example:author",
  did,
  uri: `at://${did}/com.suibari.nagi.reaction/reaction`,
  handle: null,
  displayName: null,
  avatarCid: null,
  ...overrides,
});

test("hides reactor identities from third parties while retaining viewer removal state", () => {
  const viewerDid = "did:example:viewer";
  const rows = [
    ...Array.from({ length: 5 }, (_, index) => row(`did:example:${index}`)),
    row(viewerDid),
  ];
  const reaction = groupReactionViews(rows, viewerDid)
    .get(rows[0].subjectUri)
    ?.at(0);

  assert.deepEqual(reaction?.reactors, []);
  assert.equal(reaction?.hasMoreReactors, true);
  assert.equal(reaction?.reactedByMe, true);
  assert.equal(reaction?.viewerReactionUri, rows[5].uri);
});

test("shows capped reactor identities only to the receiving post author", () => {
  const viewerDid = "did:example:author";
  const rows = Array.from({ length: 6 }, (_, index) =>
    row(`did:example:${index}`),
  );
  const reaction = groupReactionViews(rows, viewerDid)
    .get(rows[0].subjectUri)
    ?.at(0);

  assert.equal(reaction?.reactors.length, 5);
  assert.equal(reaction?.hasMoreReactors, true);
  assert.equal(reaction?.reactedByMe, undefined);
});

test("does not expose reactor identities for anonymous or non-post subjects", () => {
  for (const viewerDid of [undefined, "did:example:viewer"]) {
    const reaction = groupReactionViews([
      row("did:example:reactor", { subjectDid: null }),
    ], viewerDid)
      .values()
      .next().value?.[0];

    assert.deepEqual(reaction?.reactors, []);
    assert.equal(reaction?.hasMoreReactors, true);
  }
});

test("marks a third party viewer's lone reaction without inventing anonymous others", () => {
  const viewerDid = "did:example:viewer";
  const reaction = groupReactionViews([row(viewerDid)], viewerDid)
    .values()
    .next().value?.[0];

  assert.deepEqual(reaction?.reactors, []);
  assert.equal(reaction?.hasMoreReactors, undefined);
  assert.equal(reaction?.reactedByMe, true);
});

test("keeps custom emoji and subjects in separate groups", () => {
  const bluemoji: EmojiView = {
    uri: "at://did:example:emoji/blue.moji.collection.item/party",
    cid: "bafyemoji",
    did: "did:example:emoji",
    name: "party",
    url: "/api/blob/did%3Aexample%3Aemoji/bafyimage",
    mediaType: "image/png",
  };
  const otherSubject = "at://did:example:bot/com.suibari.nagi.news/news-2";
  const grouped = groupReactionViews([
    row("did:example:a", {
      emoji: "party",
      emojiKey: bluemoji.uri,
      emojiUri: bluemoji.uri,
      bluemoji,
    }),
    row("did:example:b", { subjectUri: otherSubject }),
  ]);

  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.values().next().value?.[0].bluemoji, bluemoji);
  assert.equal(grouped.get(otherSubject)?.[0].emoji, "🎉");
});

test("drops a custom reaction when its emoji is unavailable", () => {
  const emojiUri = "at://did:example:deleted/blue.moji.collection.item/party";
  const reaction = groupReactionViews([
    row("did:example:reactor", {
      emoji: ":party:",
      emojiKey: emojiUri,
      emojiUri,
    }),
  ])
    .values()
    .next().value?.[0];

  assert.equal(reaction, undefined);
});
