import assert from "node:assert/strict";
import test from "node:test";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";

const post = (labels?: unknown) => ({
  $type: NAGI.post,
  text: "test",
  createdAt: "2026-08-15T00:00:00.000Z",
  ...(labels === undefined ? {} : { labels }),
});

test("accepts the supported AI and NSFW self labels", () => {
  assert.equal(
    validateRecord(
      NAGI.post,
      post({
        $type: "com.atproto.label.defs#selfLabels",
        values: [
          { val: "ai-generated" },
          { val: "sexual" },
          { val: "graphic-media" },
        ],
      }),
    ),
    true,
  );
});

test("rejects reserved and unknown self labels", () => {
  for (const val of ["!warn", "hate", "unknown"]) {
    assert.equal(
      validateRecord(
        NAGI.post,
        post({
          $type: "com.atproto.label.defs#selfLabels",
          values: [{ val }],
        }),
      ),
      false,
    );
  }
});
