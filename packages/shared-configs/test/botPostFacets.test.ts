import assert from "node:assert/strict";
import test from "node:test";
import { RichText } from "@atproto/api";
import { sanitizeBotPostFacets } from "../src/util/botPostFacets.js";

function detect(text: string) {
  const rt = new RichText({ text });
  rt.detectFacetsWithoutResolution();
  return rt.facets;
}

function links(text: string, facets: ReturnType<typeof sanitizeBotPostFacets>) {
  const bytes = new TextEncoder().encode(text);
  return facets.flatMap((facet) =>
    (facet.features as Array<{ $type: string; uri?: string }>)
      .filter((feature) => feature.$type === "app.bsky.richtext.facet#link")
      .map((feature) => ({
        uri: feature.uri,
        covered: new TextDecoder().decode(bytes.subarray(facet.index.byteStart, facet.index.byteEnd)),
      })),
  );
}

test("名前に使ったハンドルやドメイン入りの表示名はリンクにしない", () => {
  // 2026-09-30 の現物。定型文の ${name} にハンドルが入り、後ろの文ごとリンクになっていた。
  for (const text of [
    "syb07.bsky.socialさん、そんな装備で全肯定されて大丈夫か？",
    "kailtonvergara.bsky.social, você é subestimado!",
    "I'm officially a fan of Marko @ admin.education.",
    "last.fmと連携すれば、Spotifyで聴いた曲をBlueskyに自動で",
  ]) {
    assert.deepEqual(links(text, sanitizeBotPostFacets(text, detect(text))), [], text);
  }
});

test("https:// 付きの URL は残し、直後の日本語や句読点はリンクに含めない", () => {
  const text = "お部屋は https://room.bot-tan.comだよ！ ダッシュボード https://bot-tan.com/。";
  assert.deepEqual(links(text, sanitizeBotPostFacets(text, detect(text))), [
    { uri: "https://room.bot-tan.com", covered: "https://room.bot-tan.com" },
    { uri: "https://bot-tan.com/", covered: "https://bot-tan.com/" },
  ]);
});

test("メンションは許可した DID だけ残す", () => {
  const text = "@alice.example と @bob.example";
  const mention = (handle: string, did: string) => {
    const start = text.indexOf(handle);
    const byteStart = new TextEncoder().encode(text.slice(0, start)).length;
    return {
      index: { byteStart, byteEnd: byteStart + new TextEncoder().encode(handle).length },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }],
    };
  };
  const facets = [mention("@alice.example", "did:plc:alice"), mention("@bob.example", "did:plc:bob")];

  const kept = sanitizeBotPostFacets(text, facets, { allowedMentionDids: ["did:plc:alice"] });
  assert.deepEqual(kept.map((facet) => facet.features), [[{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }]]);
  assert.deepEqual(sanitizeBotPostFacets(text, facets), []);
});

test("タグはそのまま残す", () => {
  const text = "今日もすてき #Nagi";
  assert.deepEqual(
    sanitizeBotPostFacets(text, detect(text)).flatMap((facet) => facet.features),
    [{ $type: "app.bsky.richtext.facet#tag", tag: "Nagi" }],
  );
});
