import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/middleware/errors.js";
import {
  jstDayStart,
  normalizeNewsUrl,
  submissionStatus,
  validateNewsReviewSubject,
} from "../src/services/userNewsSubmissionPolicy.js";

test("normalizes tracking parameters without changing meaningful parameters", () => {
  assert.equal(
    normalizeNewsUrl("https://example.com/story?id=7&utm_source=nagi#section"),
    "https://example.com/story?id=7",
  );
});

test("uses the JST calendar boundary for daily submissions", () => {
  assert.equal(
    jstDayStart(new Date("2026-08-01T15:30:00.000Z")).toISOString(),
    "2026-08-01T15:00:00.000Z",
  );
});

test("accepts only the authenticated owner's news StrongRef", () => {
  const did = "did:plc:alice";
  assert.deepEqual(
    validateNewsReviewSubject(did, {
      uri: `at://${did}/com.suibari.nagi.news/abc`,
      cid: "bafy-test",
    }),
    { did, collection: "com.suibari.nagi.news", rkey: "abc" },
  );
  for (const uri of [
    "at://did:plc:bob/com.suibari.nagi.news/abc",
    `at://${did}/com.suibari.nagi.post/abc`,
    "not-an-at-uri",
  ]) {
    assert.throws(
      () => validateNewsReviewSubject(did, { uri, cid: "bafy-test" }),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  }
});

test("reports published news as approved while the bot comment is pending or failed", () => {
  assert.equal(submissionStatus("pending", "approved", null), "approved");
  assert.equal(submissionStatus("processing", "approved", null), "approved");
  assert.equal(submissionStatus("failed", "approved", null), "approved");
});

test("reports hidden news as rejected and deleted news as cancelled", () => {
  assert.equal(submissionStatus("approved", "hidden", new Date()), "rejected");
  assert.equal(submissionStatus("cancelled", "approved", null), "cancelled");
});

test("falls back to the job state for legacy jobs without an approval", () => {
  assert.equal(submissionStatus("pending", null, null), "pending");
  assert.equal(submissionStatus("rejected", null, null), "rejected");
});
