import assert from "node:assert/strict";
import test from "node:test";
import { nagiPostMedia } from "../index.js";

const image = { image: { $type: "blob", ref: { $link: "bafyimage" }, mimeType: "image/png", size: 1 }, alt: "絵" };
const video = { video: { $type: "blob", ref: { $link: "bafyvideo" }, mimeType: "video/mp4", size: 1 }, alt: "動画" };

test("#images の画像を返す", () => {
  assert.deepEqual(
    nagiPostMedia({ $type: "com.suibari.nagi.post#images", images: [image] }),
    { images: [image], video: null },
  );
});

test("#video は embed 自体を $type 抜きで返す", () => {
  assert.deepEqual(
    nagiPostMedia({ $type: "com.suibari.nagi.post#video", ...video }),
    { images: [], video },
  );
});

test("#gallery は画像と動画に分け、$type を落とす", () => {
  assert.deepEqual(
    nagiPostMedia({
      $type: "com.suibari.nagi.post#gallery",
      items: [
        { $type: "com.suibari.nagi.post#image", ...image },
        { $type: "com.suibari.nagi.post#video", ...video },
        { $type: "com.suibari.nagi.post#unknown", foo: 1 },
      ],
    }),
    { images: [image], video },
  );
});

test("#quote の images / video を返す", () => {
  const record = { uri: "at://did:plc:a/com.suibari.nagi.post/1", cid: "bafy" };
  assert.deepEqual(
    nagiPostMedia({ $type: "com.suibari.nagi.post#quote", record, video }),
    { images: [], video },
  );
  assert.deepEqual(
    nagiPostMedia({ $type: "com.suibari.nagi.post#quote", record, images: [image] }),
    { images: [image], video: null },
  );
  assert.deepEqual(
    nagiPostMedia({ $type: "com.suibari.nagi.post#quote", record, images: [image], video }),
    { images: [image], video },
  );
});

test("embed が無い・未知の型なら空", () => {
  assert.deepEqual(nagiPostMedia(undefined), { images: [], video: null });
  assert.deepEqual(nagiPostMedia({ $type: "app.bsky.embed.images", images: [image] }), { images: [], video: null });
});
