import assert from "node:assert/strict";
import test from "node:test";
import { agent } from "../src/agent.js";
import { publishScheduledPost } from "../src/ScheduledPostFeature.js";

// 公開IPのfixtureでDNSに依存せずOGP取得からPDSへ渡すレコードまで通す。
// fetchとPDS境界はすべてスタブ化し、実際の投稿・アップロードは行わない。
const url = "https://93.184.216.34/post";
const blob = {
  ref: { toString: () => "bafyimage" }, mimeType: "image/png", size: 4,
};
for (const network of ["bsky", "nagi"] as const) {
  for (const withImage of [false, true]) {
    for (const ogpAvailable of [false, true]) {
      test(`${network} → Nagi: 絵=${withImage}, OGP=${ogpAvailable}、引用せずカードで紹介`, async (t) => {
        let record: any;
        let indexed = false;
        t.mock.method(globalThis, "fetch", async (input: any) => {
          const target = String(input);
          if (target.endsWith("/internal/bot-records/ensure")) {
            indexed = true;
            return new Response("{}", { headers: { "content-type": "application/json" } });
          }
          if (!ogpAvailable) return new Response("unavailable", { status: 503 });
          if (target === url) return new Response(
            '<meta property="og:title" content="紹介元の投稿"><meta property="og:description" content="投稿本文"><meta property="og:image" content="/card.png">',
            { headers: { "content-type": "text/html" } },
          );
          assert.equal(target, "https://93.184.216.34/card.png");
          return new Response("stub", { headers: { "content-type": "image/png" } });
        });
        t.mock.method(agent, "uploadBlob", async () => ({ data: { blob } }));
        t.mock.method(agent.api.com.atproto.repo, "createRecord", async (params: any) => {
          record = params.record;
          return { data: { uri: "at://did:plc:bot/com.suibari.nagi.post/new", cid: "new-cid" } };
        });
        await publishScheduledPost({
          kind: "good-night", text: `おやすみ！\n\n${url}`, langs: ["ja"],
          ...(withImage ? { image: { dataBase64: "c3R1Yg==", mimeType: "image/png", alt: "今日の絵" } } : {}),
        });
        assert.equal(indexed, true);
        assert.equal(record.text, `おやすみ！\n\n${url}`);
        assert.equal(record.embed?.$type, withImage ? "com.suibari.nagi.post#images" : undefined);
        assert.equal(record.embed?.record, undefined);
        if (withImage) assert.equal(record.embed.images[0].alt, "今日の絵");
        assert.equal(record.linkCards?.length ?? 0, ogpAvailable ? 1 : 0);
        if (ogpAvailable) {
          assert.equal(record.linkCards[0].uri, url);
          assert.equal(record.linkCards[0].title, "紹介元の投稿");
          assert.equal(record.linkCards[0].thumb.ref.$link, "bafyimage");
        }
        assert.ok(record.facets.some((facet: any) => facet.features.some((f: any) => f.uri === url)));
      });
    }
  }
}

const BOT_DID = "did:plc:bot";
const nightVideo = { uri: `at://${BOT_DID}/app.bsky.feed.post/video`, cid: "video-post-cid" };
// getRecord は blob を BlobRef（ref は CID オブジェクト）に復元して返す。
const videoPostRecord = {
  $type: "app.bsky.feed.post",
  text: "今夜の動画",
  embed: {
    $type: "app.bsky.embed.video",
    alt: "全肯定botたんの動画",
    aspectRatio: { width: 1080, height: 1920 },
    video: { ref: { toString: () => "bafyvideo" }, mimeType: "video/mp4", size: 13_490_288 },
  },
};
const expectedVideo = {
  video: { $type: "blob", ref: { $link: "bafyvideo" }, mimeType: "video/mp4", size: 13_490_288 },
  alt: "全肯定botたんの動画",
  aspectRatio: { width: 1080, height: 1920 },
};

for (const withImage of [false, true]) {
  test(`おやすみ：夜の動画を同じ blob で埋め込む（絵=${withImage}）`, async (t) => {
    process.env.NAGI_BOT_DID = BOT_DID;
    let record: any;
    let uploads = 0;
    t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    t.mock.method(agent, "uploadBlob", async () => {
      uploads++;
      return { data: { blob } };
    });
    t.mock.method(agent.com.atproto.repo, "getRecord", async (params: any) => {
      assert.deepEqual(params, { repo: BOT_DID, collection: "app.bsky.feed.post", rkey: "video" });
      return { data: { uri: nightVideo.uri, value: videoPostRecord } };
    });
    t.mock.method(agent.api.com.atproto.repo, "createRecord", async (params: any) => {
      record = params.record;
      return { data: { uri: `at://${BOT_DID}/com.suibari.nagi.post/new`, cid: "new-cid" } };
    });
    await publishScheduledPost({
      kind: "good-night", text: "おやすみ！", langs: ["ja"], nightVideo,
      ...(withImage ? { image: { dataBase64: "c3R1Yg==", mimeType: "image/png", width: 1, height: 1, alt: "今日の絵" } } : {}),
    });
    assert.equal(uploads, withImage ? 1 : 0, "動画は上げ直さない");
    if (withImage) {
      assert.equal(record.embed.$type, "com.suibari.nagi.post#gallery");
      assert.deepEqual(record.embed.items.map((item: any) => item.$type), [
        "com.suibari.nagi.post#image",
        "com.suibari.nagi.post#video",
      ]);
      assert.equal(record.embed.items[0].alt, "今日の絵");
      const { $type: _type, ...video } = record.embed.items[1];
      assert.deepEqual(video, expectedVideo);
    } else {
      const { $type, ...video } = record.embed;
      assert.equal($type, "com.suibari.nagi.post#video");
      assert.deepEqual(video, expectedVideo);
    }
  });
}

test("おやすみ：動画を取れない・他人の投稿なら絵だけで出す", async (t) => {
  process.env.NAGI_BOT_DID = BOT_DID;
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  t.mock.method(agent, "uploadBlob", async () => ({ data: { blob } }));
  const getRecord = t.mock.method(agent.com.atproto.repo, "getRecord", async () => {
    throw new Error("RecordNotFound");
  });
  const records: any[] = [];
  t.mock.method(agent.api.com.atproto.repo, "createRecord", async (params: any) => {
    records.push(params.record);
    return { data: { uri: `at://${BOT_DID}/com.suibari.nagi.post/new`, cid: "new-cid" } };
  });
  const image = { dataBase64: "c3R1Yg==", mimeType: "image/png", width: 1, height: 1, alt: "今日の絵" };
  await publishScheduledPost({ kind: "good-night", text: "おやすみ！", nightVideo, image });
  await publishScheduledPost({
    kind: "good-night", text: "おやすみ！", image,
    nightVideo: { uri: "at://did:plc:someone/app.bsky.feed.post/video", cid: "x" },
  });
  assert.equal(getRecord.mock.callCount(), 1, "他人の投稿は取りに行かない");
  for (const record of records) assert.equal(record.embed.$type, "com.suibari.nagi.post#images");
});
