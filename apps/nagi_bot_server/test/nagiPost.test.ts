import assert from "node:assert/strict";
import test from "node:test";
import { detectNagiFacets } from "../src/nagiLinkCards.js";
import { buildNagiPostRecord } from "../src/nagiPost.js";
import { buildBluemojiFacets } from "../src/nagiBluemojiFacets.js";

test("detects hashtag facets as well as links", () => {
  const text = "今日もすてき #Nagi https://example.com/path";
  const { facets, urls } = detectNagiFacets(text);

  assert.deepEqual(
    facets.flatMap((facet) => facet.features),
    [
      { $type: "app.bsky.richtext.facet#tag", tag: "Nagi" },
      { $type: "app.bsky.richtext.facet#link", uri: "https://example.com/path" },
    ],
  );
  assert.deepEqual(urls, ["https://example.com/path"]);
});

test("does not save unresolved mention facets", () => {
  const { facets } = detectNagiFacets("@alice.example #hello");

  assert.deepEqual(
    facets.flatMap((facet) => facet.features),
    [{ $type: "app.bsky.richtext.facet#tag", tag: "hello" }],
  );
});

test("does not auto-link a reply recipient handle used as a name", () => {
  const handle = "elle139.bsky.social";
  const text = `${handle}、すてきだね。${handle}のままでいてね。`;
  const { facets, urls } = detectNagiFacets(text, [handle]);

  assert.deepEqual(facets, []);
  assert.deepEqual(urls, []);
});

test("the common post record builder applies reply handle exclusions", async () => {
  const handle = "elle139.bsky.social";
  const record = await buildNagiPostRecord({
    text: `${handle}、今日もすてきだね。`,
    autoLinkExclusions: [handle],
    label: "NAGI_REPLY_TEST",
    langs: ["ja"],
  });

  assert.equal(record.facets, undefined);
  assert.equal(record.linkCards, undefined);
});

test("keeps ordinary links when excluding a reply recipient handle", () => {
  const handle = "elle139.bsky.social";
  const text = `${handle}、リンクはこちら https://${handle}/profile と example.com を見てね。`;
  const { facets, urls } = detectNagiFacets(text, [handle]);

  assert.deepEqual(urls, [
    `https://${handle}/profile`,
    "https://example.com",
  ]);
  assert.deepEqual(
    facets.flatMap((facet) => facet.features),
    urls.map((uri) => ({
      $type: "app.bsky.richtext.facet#link",
      uri,
    })),
  );
});

test("the common post record builder always detects tag facets", async () => {
  const record = await buildNagiPostRecord({
    text: "定期投稿です #botたん",
    label: "TEST",
    langs: ["ja"],
    labels: {
      $type: "com.atproto.label.defs#selfLabels",
      values: [{ val: "sexual" }],
    },
  });

  assert.equal(record.$type, "com.suibari.nagi.post");
  assert.deepEqual(record.langs, ["ja"]);
  assert.deepEqual(record.labels, {
    $type: "com.atproto.label.defs#selfLabels",
    values: [{ val: "sexual" }, { val: "ai-generated" }],
  });
  assert.deepEqual(
    record.facets?.flatMap((facet) => facet.features),
    [{ $type: "app.bsky.richtext.facet#tag", tag: "botたん" }],
  );
});

test("the common post record builder resolves every known Bluemoji alias", async () => {
  const sourceUri =
    "at://did:plc:emoji/blue.moji.collection.item/source-yabai";
  const record = await buildNagiPostRecord(
    {
      text: "夜だね :yabai: また :yabai: :free: :missing:",
      label: "TEST",
      langs: ["ja"],
      sourceFacets: [
        {
          index: { byteStart: 0, byteEnd: 7 },
          features: [
            {
              $type: "com.suibari.nagi.richtext#bluemoji",
              ref: { uri: sourceUri, cid: "bafysource" },
              did: "did:plc:emoji",
              name: ":yabai:",
              mediaType: "image/webp",
            },
          ],
        },
      ],
    },
    async (aliases) => {
      assert.deepEqual(aliases, [
        { name: ":yabai:", preferredUri: sourceUri },
        { name: ":free:" },
        { name: ":missing:" },
      ]);
      return aliases.map(({ name }) => ({
        name,
        ...(name !== ":missing:"
          ? {
              emoji: {
                uri:
                  name === ":yabai:"
                    ? sourceUri
                    : "at://did:plc:emoji/blue.moji.collection.item/free",
                cid: name === ":yabai:" ? "bafysource" : "bafyfree",
                did: "did:plc:emoji",
                name,
                url: "/api/emoji-asset/test",
                mediaType: "image/webp" as const,
                formats: {
                  $type: "blue.moji.richtext.facet#formats_v0" as const,
                  webp_128: "bafyasset",
                },
              },
            }
          : {}),
      }));
    },
  );

  const emojiFacets =
    record.facets?.filter((facet) =>
      facet.features.some(
        (feature: any) =>
          feature?.$type === "com.suibari.nagi.richtext#bluemoji",
      ),
    ) ?? [];
  assert.equal(emojiFacets.length, 3);
  assert.deepEqual(
    emojiFacets.map((facet) =>
      Buffer.from(record.text)
        .subarray(facet.index.byteStart, facet.index.byteEnd)
        .toString("utf8"),
    ),
    [":yabai:", ":yabai:", ":free:"],
  );
  assert.equal(
    record.facets?.some((facet) =>
      facet.features.some((feature: any) => feature?.name === ":missing:"),
    ),
    false,
  );
});

test("does not turn an alias inside a detected URL into Bluemoji", () => {
  const text = "https://example.com/:party:";
  const detected = detectNagiFacets(text).facets;
  const facets = buildBluemojiFacets(
    text,
    [
      {
        name: ":party:",
        emoji: {
          uri: "at://did:plc:emoji/blue.moji.collection.item/party",
          cid: "bafyparty",
          did: "did:plc:emoji",
          name: ":party:",
          url: "/api/emoji-asset/test",
          mediaType: "image/webp",
        },
      },
    ],
    detected,
  );

  assert.deepEqual(facets, []);
});
