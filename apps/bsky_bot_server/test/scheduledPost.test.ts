import assert from "node:assert/strict";
import test from "node:test";
import { agent } from "../src/bsky/agent.js";
import { publishScheduledPost } from "../src/ScheduledPostFeature.js";

function productionEnv(t: { after: (fn: () => void) => void }) {
  const previousEnv = process.env.NODE_ENV;
  const previousLeaflet = process.env.LEAFLET_USERNAME;
  process.env.NODE_ENV = "production";
  delete process.env.LEAFLET_USERNAME;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousLeaflet === undefined) delete process.env.LEAFLET_USERNAME;
    else process.env.LEAFLET_USERNAME = previousLeaflet;
  });
}

const video = { uri: "at://did:plc:bot/app.bsky.feed.post/video", cid: "video-cid" };

test("夜の動画がある日は、動画へコメントをリプライして RP し、出来事を別スレッドで出す", async (t) => {
  productionEnv(t);
  const calls: string[] = [];
  t.mock.method(agent, "repost", async (uri: string, cid: string) => {
    assert.equal(uri, video.uri);
    assert.equal(cid, video.cid);
    calls.push("repost");
    return { uri: "at://repost", cid: "repost-cid" };
  });
  t.mock.method(agent, "post", async (record: any) => {
    if (record.text === "動画も見てね") {
      calls.push("comment");
      assert.deepEqual(record.reply, { root: video, parent: video });
      return { uri: "at://comment", cid: "comment-cid" };
    }
    calls.push("post");
    assert.equal(record.text, "おやすみ！");
    assert.equal(record.reply, undefined);
    assert.equal(record.embed, undefined);
    return { uri: "at://post", cid: "post-cid" };
  });
  const result = await publishScheduledPost({
    kind: "good-night", text: "おやすみ！",
    nightVideo: { ...video, commentText: "動画も見てね" },
  });
  assert.deepEqual(calls, ["comment", "repost", "post"]);
  assert.deepEqual(result, {
    uri: "at://post", cid: "post-cid",
    nightVideoComment: { uri: "at://comment", cid: "comment-cid" },
  });
});

test("動画の紹介に失敗しても出来事スレッドは出す", async (t) => {
  productionEnv(t);
  t.mock.method(agent, "repost", async () => { throw new Error("repost down"); });
  t.mock.method(agent, "post", async (record: any) => {
    if (record.reply) throw new Error("reply down");
    return { uri: "at://post", cid: "post-cid" };
  });
  t.mock.method(console, "error", () => {});
  const result = await publishScheduledPost({
    kind: "good-night", text: "おやすみ！",
    nightVideo: { ...video, commentText: "動画も見てね" },
  });
  assert.deepEqual(result, { uri: "at://post", cid: "post-cid" });
});

test("夜の動画が無い日は RP もリプライもしない", async (t) => {
  productionEnv(t);
  t.mock.method(agent, "repost", async () => { throw new Error("should not repost"); });
  const posted: any[] = [];
  t.mock.method(agent, "post", async (record: any) => {
    posted.push(record);
    return { uri: "at://post", cid: "post-cid" };
  });
  await publishScheduledPost({ kind: "good-night", text: "おやすみ！" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].reply, undefined);
});
