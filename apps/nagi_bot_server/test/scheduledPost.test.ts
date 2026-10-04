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
          sourcePost: {
            network,
            uri: `at://did:plc:source/${network === "nagi" ? "com.suibari.nagi.post" : "app.bsky.feed.post"}/source`,
            cid: "source-cid",
          },
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
