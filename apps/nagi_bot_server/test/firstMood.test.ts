import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_MOOD_WINDOW_MS, shouldNotifyFirstMood } from "../src/NagiPostMoodWorker.js";

const now = new Date("2026-11-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("始めたばかりの人の1件目の採点だけを知らせる", () => {
  assert.equal(shouldNotifyFirstMood({ scoredCount: 1, firstPostAt: ago(60_000), now }), true);
  assert.equal(
    shouldNotifyFirstMood({ scoredCount: 1, firstPostAt: ago(FIRST_MOOD_WINDOW_MS), now }),
    true,
  );
});

test("2件目以降や、前から使っている人のバックフィルでは知らせない", () => {
  assert.equal(shouldNotifyFirstMood({ scoredCount: 2, firstPostAt: ago(60_000), now }), false);
  assert.equal(shouldNotifyFirstMood({ scoredCount: 0, firstPostAt: ago(60_000), now }), false);
  assert.equal(
    shouldNotifyFirstMood({ scoredCount: 1, firstPostAt: ago(FIRST_MOOD_WINDOW_MS + 1), now }),
    false,
  );
  assert.equal(shouldNotifyFirstMood({ scoredCount: 1, firstPostAt: null, now }), false);
});
