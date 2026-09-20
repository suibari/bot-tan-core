import assert from "node:assert/strict";
import test from "node:test";
import { getYoutubeLiveForWhimsical } from "../src/ScheduledPostCoordinator.js";

test("次の配信枠がなければ通常投稿用にnullを返す", async () => {
  assert.equal(await getYoutubeLiveForWhimsical(async () => null), null);
});

test("配信DB取得がthrowしても通常投稿を継続できる", async () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await getYoutubeLiveForWhimsical(async () => {
      throw new Error("database unavailable");
    }), null);
  } finally {
    console.error = original;
  }
});
