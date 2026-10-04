import assert from "node:assert/strict";
import test from "node:test";
import { agent } from "../src/bsky/agent.js";
import { publishScheduledPost } from "../src/ScheduledPostFeature.js";

test("Bluesky同士のおやすみはリポストしてから本文を投稿する", async (t) => {
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
  const calls: string[] = [];
  t.mock.method(agent, "repost", async (uri: string, cid: string) => {
    assert.equal(uri, "at://did:plc:source/app.bsky.feed.post/source");
    assert.equal(cid, "source-cid");
    calls.push("repost");
    return { uri: "at://repost", cid: "repost-cid" };
  });
  t.mock.method(agent, "post", async (record: any) => {
    calls.push("post");
    assert.equal(record.text, "おやすみ！");
    assert.equal(record.embed, undefined);
    return { uri: "at://post", cid: "post-cid" };
  });
  await publishScheduledPost({
    kind: "good-night", text: "おやすみ！",
    sourcePost: { network: "bsky", uri: "at://did:plc:source/app.bsky.feed.post/source", cid: "source-cid" },
  });
  assert.deepEqual(calls, ["repost", "post"]);
});
