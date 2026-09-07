import assert from "node:assert/strict";
import test from "node:test";
import {
  canReadReactionHistory,
  profileInterestKeywords,
} from "../src/queries/profile.js";

test("profile interest keywords retain every candidate for per-view selection", () => {
  assert.deepEqual(
    profileInterestKeywords([{ keyword: "music" }, { keyword: "walking" }]),
    ["music", "walking"],
  );
});

test("reaction history is readable only by the profile owner", () => {
  const owner = "did:example:owner";

  assert.equal(canReadReactionHistory(owner, owner), true);
  assert.equal(canReadReactionHistory(owner, "did:example:other"), false);
  assert.equal(canReadReactionHistory(owner, undefined), false);
});
