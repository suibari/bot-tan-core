import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPostThread,
  mentionedDids,
  mentionsDid,
} from "../src/postTargeting.js";

const BOT = "did:plc:bot";
const USER = "did:plc:user";
const OTHER = "did:plc:other";
const ref = (did: string) => ({ uri: `at://${did}/app.bsky.feed.post/rkey` });
const mention = (did: string) => ({
  features: [{ $type: "app.bsky.richtext.facet#mention", did }],
});

test("全Mention Facetを出現順に走査する", () => {
  const record = { facets: [mention(OTHER), mention(BOT)] };
  assert.deepEqual(mentionedDids(record), [OTHER, BOT]);
  assert.equal(mentionsDid(record, BOT), true);
});

test("トップレベル・本人ルート・botルートを分類する", () => {
  assert.equal(classifyPostThread({}, USER, BOT), "top-level");
  assert.equal(
    classifyPostThread({ reply: { root: ref(USER), parent: ref(BOT) } }, USER, BOT),
    "self-thread",
  );
  assert.equal(
    classifyPostThread({ reply: { root: ref(BOT), parent: ref(BOT) } }, USER, BOT),
    "bot-thread",
  );
});

test("botルート内の第三者返信と第三者ルートを安全側で分離する", () => {
  assert.equal(
    classifyPostThread({ reply: { root: ref(BOT), parent: ref(OTHER) } }, USER, BOT),
    "bot-thread-third-party",
  );
  assert.equal(
    classifyPostThread({ reply: { root: ref(OTHER), parent: ref(BOT) } }, USER, BOT),
    "third-party-thread",
  );
  assert.equal(
    classifyPostThread({ reply: { root: {}, parent: {} } }, USER, BOT),
    "third-party-thread",
  );
});
