import assert from "node:assert/strict";
import test from "node:test";
import { crosspostView } from "../src/queries/crosspost.js";

const did = "did:plc:author";
const ref = (rkey: string, owner = did) => ({
  uri: `at://${owner}/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
});

test("自分のクロスポストの参照は作者本人にだけ返す", () => {
  const record = { crosspost: { root: ref("a"), tail: ref("b") } };
  assert.deepEqual(crosspostView(did, record, did), {
    crosspost: { root: ref("a"), tail: ref("b"), threadRoot: ref("a") },
  });
  assert.deepEqual(crosspostView(did, record, "did:plc:other"), {});
  assert.deepEqual(crosspostView(did, record, undefined), {});
});

test("Bluesky 上のスレッドの先頭が記録されていればそれを使う", () => {
  const record = { crosspost: { root: ref("a"), tail: ref("a"), threadRoot: ref("t") } };
  assert.equal(crosspostView(did, record, did).crosspost?.threadRoot.uri, ref("t").uri);
});

test("他人の repo や Bluesky 投稿以外を指す参照は無視する", () => {
  for (const crosspost of [
    { root: ref("a", "did:plc:other"), tail: ref("a") },
    { root: { uri: `at://${did}/com.suibari.nagi.post/a`, cid: "x" }, tail: ref("a") },
    { root: ref("a") },
    { root: { uri: ref("a").uri }, tail: ref("a") },
    "broken",
  ])
    assert.deepEqual(crosspostView(did, { crosspost }, did), {});
});
