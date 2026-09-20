import assert from "node:assert/strict";
import test from "node:test";
import {
  isYoutubeWatchUrl,
} from "../src/index.js";

test("YouTube watch直リンクだけをライブ紹介に採用する", () => {
  assert.equal(isYoutubeWatchUrl("https://www.youtube.com/watch?v=live-id"), true);
  assert.equal(isYoutubeWatchUrl("https://youtube.com/watch?v=live-id"), true);
  assert.equal(isYoutubeWatchUrl("https://www.youtube.com/@channel"), false);
  assert.equal(isYoutubeWatchUrl("https://example.com/watch?v=live-id"), false);
  assert.equal(isYoutubeWatchUrl("not a url"), false);
});
