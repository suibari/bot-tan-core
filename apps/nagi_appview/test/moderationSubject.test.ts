import assert from "node:assert/strict";
import test from "node:test";
import { BLUEMOJI_ITEM, NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  MODERATED_COLLECTIONS,
  emojiAssetUrl,
  isKossoriSubject,
  moderationSubject,
} from "../src/services/moderation/subject.js";

const DID = "did:plc:author";

test("extracts post text, alt and link card copy", () => {
  const input = moderationSubject(
    NAGI.post,
    {
      text: "hello",
      embed: {
        images: [{ alt: "an alt", image: { ref: { $link: "bafyimage" } } }],
        linkCard: { title: "card title", description: "card body" },
      },
    },
    DID,
  );
  assert.ok(input);
  assert.deepEqual(input.texts, ["hello", "an alt", "card title", "card body"]);
  assert.equal(input.imageUrls.length, 1);
});

test("post images are fetched through the AppView blob proxy, not a third party", () => {
  const input = moderationSubject(
    NAGI.post,
    { text: "x", embed: { images: [{ image: { ref: { $link: "bafyimage" } } }] } },
    DID,
  )!;
  assert.match(input.imageUrls[0], /\/api\/blob\//);
  assert.ok(!input.imageUrls[0].includes("cdn.bsky.app"));
});

test("extracts profile and channel fields", () => {
  const profile = moderationSubject(
    NAGI.profile,
    { displayName: "name", description: "bio", avatar: { ref: { $link: "bafyavatar" } } },
    DID,
  )!;
  assert.deepEqual(profile.texts, ["name", "bio"]);
  assert.equal(profile.imageUrls.length, 1);

  const channel = moderationSubject(
    NAGI.channel,
    { name: "ch", description: "about", banner: { ref: { $link: "bafybanner" } } },
    DID,
  )!;
  assert.deepEqual(channel.texts, ["ch", "about"]);
  assert.equal(channel.imageUrls.length, 1);
});

test("news is text only", () => {
  const news = moderationSubject(
    NAGI.news,
    { titleJa: "見出し", sourceName: "出典" },
    DID,
  )!;
  assert.deepEqual(news.texts, ["見出し", "出典"]);
  assert.equal(news.imageUrls.length, 0);
});

test("collections we must not send to OpenAI return null", () => {
  for (const collection of [
    NAGI.reaction,
    NAGI.diary,
    NAGI.appLinks,
    "com.example.unknown",
  ]) {
    assert.equal(moderationSubject(collection, { text: "x" }, DID), null);
    assert.ok(!MODERATED_COLLECTIONS.includes(collection));
  }
});

test("blank fields are dropped instead of sent as empty strings", () => {
  const input = moderationSubject(
    NAGI.profile,
    { displayName: "name", description: "   " },
    DID,
  )!;
  assert.deepEqual(input.texts, ["name"]);
  assert.equal(input.imageUrls.length, 0);
});

test("emoji assets are only judged when they are actually images", () => {
  assert.equal(emojiAssetUrl(DID, "rkey", "bafycid", "image/png").length, 1);
  assert.equal(
    emojiAssetUrl(DID, "rkey", "bafycid", "application/lottie+zip").length,
    0,
  );
  assert.equal(emojiAssetUrl(DID, "rkey", "bafycid", undefined).length, 0);
  assert.ok(moderationSubject(BLUEMOJI_ITEM, { name: "smile", alt: "a" }, DID));
});

// こっそり投稿は OpenAI へ一切送らない。経路が3つあるので3条件すべてを見る。
test("kossori posts are excluded by the record flag", () => {
  assert.equal(
    isKossoriSubject(`at://${DID}/${NAGI.post}/abc`, { kossori: true }, false),
    true,
  );
});

test("kossori posts are excluded by the appviewOnly ingest option", () => {
  assert.equal(
    isKossoriSubject(`at://${DID}/${NAGI.post}/abc`, { text: "x" }, true),
    true,
  );
});

test("kossori posts are excluded by their AppView-owned URI", () => {
  assert.equal(
    isKossoriSubject(
      "at://did:web:nagi-api.suibari.com/com.suibari.nagi.post/abc",
      { text: "x" },
      false,
    ),
    true,
  );
});

test("ordinary posts are not treated as kossori", () => {
  assert.equal(
    isKossoriSubject(`at://${DID}/${NAGI.post}/abc`, { text: "x" }, false),
    false,
  );
});
