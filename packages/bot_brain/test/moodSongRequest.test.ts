import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MOOD_SONG_API_TIMEOUT_MS,
  moodSongApiTimeoutMs,
  withMoodSongApiCall,
} from "../src/api/moodSongRequest.js";

test("外部APIタイムアウトは既定15秒で、1〜60秒だけ上書きできる", () => {
  const warnings: string[] = [];
  assert.equal(moodSongApiTimeoutMs(undefined), DEFAULT_MOOD_SONG_API_TIMEOUT_MS);
  assert.equal(moodSongApiTimeoutMs("20000"), 20_000);
  assert.equal(moodSongApiTimeoutMs("999", warnings.push.bind(warnings)), 15_000);
  assert.equal(moodSongApiTimeoutMs("invalid", warnings.push.bind(warnings)), 15_000);
  assert.equal(warnings.length, 2);
});

test("成功ログはサービス・操作・遅延だけを記録する", async () => {
  const logs: string[] = [];
  const times = [100, 142];
  const result = await withMoodSongApiCall("lastfm", "track.search", async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    return "ok";
  }, {
    now: () => times.shift()!,
    info: logs.push.bind(logs),
    timeoutMs: 15_000,
  });
  assert.equal(result, "ok");
  assert.deepEqual(logs, [
    "[INFO][MOOD_SONG_API] service=lastfm operation=track.search status=ok elapsed_ms=42",
  ]);
  assert.doesNotMatch(logs[0]!, /api_key|query|post/i);
});

test("失敗ログはタイムアウト有無と遅延を残して例外を再送出する", async () => {
  const logs: string[] = [];
  const times = [10, 35];
  const error = new Error("secret query");
  error.name = "TimeoutError";
  await assert.rejects(() => withMoodSongApiCall("youtube", "search.song", async () => {
    throw error;
  }, {
    now: () => times.shift()!,
    warn: logs.push.bind(logs),
    timeoutMs: 15_000,
  }), error);
  assert.deepEqual(logs, [
    "[WARN][MOOD_SONG_API] service=youtube operation=search.song status=error timeout=true elapsed_ms=25",
  ]);
  assert.doesNotMatch(logs[0]!, /secret query/);
});
