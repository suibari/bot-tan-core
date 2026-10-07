import assert from "node:assert/strict";
import test from "node:test";
import type { AppBskyFeedPost } from "@atproto/api";
import { postContinuous } from "../src/bsky/postContinuous.js";

test("DJの外部カードは分割返信の先頭へ添付し、返信ツリーを保つ", async () => {
  const records: AppBskyFeedPost.Record[] = [];
  const external = { uri: "https://www.last.fm/music/Artist/_/Song", title: "Artist - Song", description: "Last.fm" };
  const result = await postContinuous("紹介文。".repeat(110), {
    uri: "at://request", cid: "request-cid",
    record: { $type: "app.bsky.feed.post", text: "DJ", createdAt: new Date().toISOString() },
  }, undefined, undefined, external, async (record) => {
    records.push(record);
    return { uri: `at://reply-${records.length}`, cid: `cid-${records.length}` };
  });
  assert.ok(records.length > 1);
  assert.deepEqual(records[0]?.embed, { $type: "app.bsky.embed.external", external });
  assert.equal(records[1]?.embed, undefined);
  assert.equal(records[0]?.reply?.parent.uri, "at://request");
  assert.equal(records[1]?.reply?.parent.uri, "at://reply-1");
  assert.equal(result.uri, "at://reply-1");
});

test("分割返信のどのポストでも、メンションを残してよいのは元の返信相手だけ", async () => {
  const options: unknown[] = [];
  await postContinuous("長い返信。".repeat(80), {
    uri: "at://did:plc:recipient/app.bsky.feed.post/abc", cid: "request-cid",
    record: { $type: "app.bsky.feed.post", text: "hi", createdAt: new Date().toISOString() },
  }, undefined, undefined, undefined, async (_record, _embed, opts) => {
    options.push(opts);
    return { uri: `at://did:plc:bot/app.bsky.feed.post/${options.length}`, cid: `cid-${options.length}` };
  });
  assert.ok(options.length > 1);
  for (const opts of options) assert.deepEqual(opts, { mentionDids: ["did:plc:recipient"] });
});

test("返信でない投稿では、どのメンションも残さない", async () => {
  const options: unknown[] = [];
  await postContinuous("ひとりごと", undefined, undefined, undefined, undefined, async (_record, _embed, opts) => {
    options.push(opts);
    return { uri: "at://did:plc:bot/app.bsky.feed.post/1", cid: "cid-1" };
  });
  assert.deepEqual(options, [{ mentionDids: [] }]);
});
