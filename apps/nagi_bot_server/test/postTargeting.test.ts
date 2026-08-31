import assert from "node:assert/strict";
import test from "node:test";
import {
  isReplyToBot,
  isThirdPartyThread,
  mentionsBot,
} from "../src/NagiReplyFeature.js";

const BOT = "did:plc:bot";
const USER = "did:plc:user";
const OTHER = "did:plc:other";
const ref = (did: string) => ({
  uri: `at://${did}/app.suibari.nagi.post/rkey`,
  cid: "bafy-test",
});
const mention = (did: string) => ({
  features: [{ $type: "app.bsky.richtext.facet#mention", did }],
});

test("Nagiも全Facetからbotメンションを検知する", () => {
  assert.equal(
    mentionsBot({ facets: [mention(OTHER), mention(BOT)] }, BOT),
    true,
  );
});

test("botへの直接返信は回数を制限せず対象のままにする", () => {
  const record = { reply: { root: ref(BOT), parent: ref(BOT) } };
  assert.equal(isReplyToBot(record, BOT), true);
  assert.equal(isThirdPartyThread(record, USER, BOT), false);
});

test("botルート内の第三者返信からのbotメンションは拒否する", () => {
  const record = {
    reply: { root: ref(BOT), parent: ref(OTHER) },
    facets: [mention(BOT)],
  };
  assert.equal(isReplyToBot(record, BOT), true);
  assert.equal(isThirdPartyThread(record, USER, BOT), true);
});
