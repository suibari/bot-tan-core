import assert from "node:assert/strict";
import test from "node:test";
import {
  isReplyInThirdPartyThread,
  isReplyOrMentionToMe,
} from "../src/bsky/util.js";
import { NormalReplyFeature } from "../src/features/NormalReplyFeature.js";
import { canContinueBskyConversation } from "../src/features/ConversationFeature.js";

const BOT = "did:plc:bot";
const USER = "did:plc:user";
const OTHER = "did:plc:other";
const ref = (did: string) => ({
  uri: `at://${did}/app.bsky.feed.post/rkey`,
  cid: "bafy-test",
});
const mention = (did: string) => ({
  index: { byteStart: 0, byteEnd: 1 },
  features: [{ $type: "app.bsky.richtext.facet#mention", did }],
});

test.before(() => {
  process.env.BSKY_DID = BOT;
});

test("自分ルートの返信内botメンションを呼びかけとして扱う", () => {
  const record = {
    text: "botたん",
    createdAt: new Date().toISOString(),
    reply: { root: ref(USER), parent: ref(USER) },
    facets: [mention(BOT)],
  } as any;
  assert.equal(isReplyOrMentionToMe(record), true);
  assert.equal(isReplyInThirdPartyThread(record, USER), false);
});

test("複数メンションの2番目にあるbotも検知する", async () => {
  const record = {
    text: "ふたりにお知らせ",
    createdAt: new Date().toISOString(),
    facets: [mention(OTHER), mention(BOT)],
  } as any;
  assert.equal(isReplyOrMentionToMe(record), true);
  assert.equal(
    await new NormalReplyFeature().shouldHandle(
      { commit: { record } } as any,
      { did: USER } as any,
      { isSubscriber: false, isCommunityMember: false },
    ),
    true,
  );
});

test("botルートでも第三者の返信への割り込みは拒否する", () => {
  const record = {
    text: "botたん",
    createdAt: new Date().toISOString(),
    reply: { root: ref(BOT), parent: ref(OTHER) },
    facets: [mention(BOT)],
  } as any;
  assert.equal(isReplyOrMentionToMe(record), true);
  assert.equal(isReplyInThirdPartyThread(record, USER), true);
});

test("botへの直接返信はbotルートでも許可する", () => {
  const record = {
    text: "お返事",
    createdAt: new Date().toISOString(),
    reply: { root: ref(BOT), parent: ref(BOT) },
  } as any;
  assert.equal(isReplyOrMentionToMe(record), true);
  assert.equal(isReplyInThirdPartyThread(record, USER), false);
  assert.equal(canContinueBskyConversation(true, record, USER, BOT), true);
  assert.equal(canContinueBskyConversation(false, record, USER, BOT), false);
});

test("サブスクでもbotルート内の第三者返信から会話へ移行しない", () => {
  const record = {
    text: "botたん",
    createdAt: new Date().toISOString(),
    reply: { root: ref(BOT), parent: ref(OTHER) },
    facets: [mention(BOT)],
  } as any;
  assert.equal(canContinueBskyConversation(true, record, USER, BOT), false);
});
