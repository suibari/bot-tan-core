import assert from "node:assert/strict";
import test from "node:test";
import { NAGI, STANDARD_SITE_DOCUMENT } from "@bsky-affirmative-bot/nagi-lexicon";
import { isEligibleReactionCardTrigger } from "../src/services/reactionCardEligibility.js";

const viewerDid = "did:plc:abcde234567";
const reactionUri = `at://${viewerDid}/${NAGI.reaction}/3abc`;
const now = new Date("2026-08-12T03:00:00.000Z");
const record = (
  subjectDid = "did:plc:bcdef234567",
  createdAt = now.toISOString(),
) => ({
  $type: NAGI.reaction,
  subject: {
    uri: `at://${subjectDid}/${NAGI.post}/3post`,
    cid: "bafyreicid",
  },
  emoji: "👍",
  createdAt,
});

test("当日の他ユーザー宛てリアクションだけがカード枠を解放する", () => {
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      reactionUri,
      {
        ...record(),
        subject: {
          uri: `at://did:plc:bcdef234567/${STANDARD_SITE_DOCUMENT}/3blog`,
          cid: "bafyreicid",
        },
      },
      now,
    ),
    true,
  );
  assert.equal(
    isEligibleReactionCardTrigger(viewerDid, reactionUri, record(), now),
    true,
  );
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      reactionUri,
      {
        ...record(),
        subject: {
          uri: `at://did:plc:bcdef234567/${NAGI.news}/3news`,
          cid: "bafyreicid",
        },
      },
      now,
    ),
    true,
  );
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      reactionUri,
      record(viewerDid),
      now,
    ),
    false,
  );
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      reactionUri,
      record("did:plc:bcdef234567", "2026-08-10T03:00:00.000Z"),
      now,
    ),
    false,
  );
});

test("本人所有でないURIやNagi外の対象は拒否する", () => {
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      `at://did:plc:cdefg234567/${NAGI.reaction}/3abc`,
      record(),
      now,
    ),
    false,
  );
  assert.equal(
    isEligibleReactionCardTrigger(
      viewerDid,
      reactionUri,
      {
        ...record(),
        subject: {
          uri: "at://did:plc:bcdef234567/app.bsky.feed.post/3post",
          cid: "bafyreicid",
        },
      },
      now,
    ),
    false,
  );
});
