import assert from "node:assert/strict";
import test from "node:test";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";
import {
  mentionNotificationRecipients,
  shouldNotifyReply,
} from "../src/util/notificationPolicy.js";

const reply = {
  root: {
    uri: "at://did:plc:root/com.suibari.nagi.post/root",
    cid: "bafyroot",
  },
  parent: {
    uri: "at://did:plc:parent/com.suibari.nagi.post/parent",
    cid: "bafyparent",
  },
};

test("normal replies notify their direct recipient", () => {
  assert.equal(shouldNotifyReply({ reply }), true);
});

test("silent replies do not notify their direct recipient", () => {
  assert.equal(shouldNotifyReply({ reply, silentReply: true }), false);
});

test("top-level posts are not reply-notification candidates", () => {
  assert.equal(shouldNotifyReply({ silentReply: true }), false);
});

test("a silent reply cannot notify its recipient through a mention", () => {
  assert.deepEqual(
    mentionNotificationRecipients(
      ["did:plc:author", "did:plc:parent", "did:plc:other"],
      "did:plc:author",
      "did:plc:parent",
    ),
    ["did:plc:other"],
  );
});

test("post validation accepts only boolean silentReply values", () => {
  const record = {
    $type: NAGI.post,
    text: "quiet context",
    createdAt: "2026-08-28T00:00:00.000Z",
    reply,
    silentReply: true,
  };
  assert.equal(validateRecord(NAGI.post, record), true);
  assert.equal(
    validateRecord(NAGI.post, { ...record, silentReply: "true" }),
    false,
  );
});
