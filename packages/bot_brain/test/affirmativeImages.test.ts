import assert from "node:assert/strict";
import test from "node:test";
import type {
  ImageOrigin,
  ImageRef,
  UserInfoGemini,
} from "@bsky-affirmative-bot/shared-configs";
import {
  affirmativeImageLabel,
  buildAffirmativeImageParts,
} from "../src/ai/affirmativeImages.js";
import { buildAffirmativePrompt } from "../src/ai/generateAffirmativeWord.js";

const userinfo = (
  text: string,
  image?: ImageRef[],
  langStr: "日本語" | "English" = "日本語",
): UserInfoGemini =>
  ({
    follower: {
      did: "did:plc:test",
      handle: "test.example",
      displayName: "テストさん",
    },
    posts: [text],
    image,
    langStr,
  }) as UserInfoGemini;

const okFetch = async () =>
  new Response(Uint8Array.from([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

test("画像付き短文では50文字制約を適用しない", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo("画像のテストを兼ねて、全肯定たん達のファンアート", [
      { image_url: "https://example.com/1.png", mimeType: "image/png" },
    ]),
  );

  assert.doesNotMatch(prompt, /50文字以内/);
  assert.match(prompt, /すべての画像/);
});

test("画像のみ投稿では300文字制約を適用しない", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo("", [
      { image_url: "https://example.com/1.png", mimeType: "image/png" },
    ]),
  );

  assert.doesNotMatch(prompt, /300文字以内/);
});

test("画像なし短文には従来の50文字制約を適用する", async () => {
  const prompt = await buildAffirmativePrompt(userinfo("短い投稿"));
  assert.match(prompt, /50文字以内/);
});

test("英語プロンプトでも全画像への具体的な言及を要求する", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo(
      "fan art",
      [{ image_url: "https://example.com/1.png", mimeType: "image/png" }],
      "English",
    ),
  );

  assert.match(prompt, /For every supplied image/);
  assert.match(prompt, /Never collapse multiple images/);
  assert.doesNotMatch(prompt, /within 50 characters/);
});

test("4枚の画像を元の順序でラベルと画像Partにする", async () => {
  const images: ImageRef[] = [
    "direct",
    "quote",
    "link-preview",
    "video-thumbnail",
  ].map((origin, index) => ({
    image_url: `https://example.com/${index + 1}.png`,
    mimeType: "image/png",
    origin: origin as ImageOrigin,
  }));

  const { parts, stats } = await buildAffirmativeImageParts(
    images,
    "日本語",
    okFetch,
  );

  assert.equal(parts.length, 8);
  for (let index = 0; index < 4; index++) {
    assert.match(parts[index * 2].text ?? "", new RegExp(`画像${index + 1}`));
    assert.equal(parts[index * 2 + 1].inlineData?.mimeType, "image/png");
  }
  assert.deepEqual(
    [stats.attempted, stats.succeeded, stats.skipped],
    [4, 4, 0],
  );
});

test("画像の出所ごとに作者帰属の指示を変える", () => {
  assert.match(affirmativeImageLabel(1, "direct", "日本語"), /投稿者本人/);
  for (const origin of [
    "quote",
    "link-preview",
    "video-thumbnail",
  ] as const) {
    assert.match(
      affirmativeImageLabel(1, origin, "日本語"),
      /作者だと決めつけず/,
    );
  }
});

test("直接添付画像の取得失敗は返信再試行のため例外にする", async () => {
  await assert.rejects(
    buildAffirmativeImageParts(
      [
        {
          image_url: "https://example.com/direct.png",
          mimeType: "image/png",
          origin: "direct",
        },
      ],
      "日本語",
      async () => new Response(null, { status: 503 }),
    ),
    /directly attached image 1/,
  );
});

test("補助画像の取得失敗はスキップして残りを処理する", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { parts, stats } = await buildAffirmativeImageParts(
      [
        {
          image_url: "https://example.com/quote.png",
          mimeType: "image/png",
          origin: "quote",
        },
        {
          image_url: "https://example.com/link.png",
          mimeType: "image/png",
          origin: "link-preview",
        },
      ],
      "日本語",
      async (url) =>
        url.includes("quote")
          ? new Response(null, { status: 404 })
          : okFetch(),
    );

    assert.equal(parts.length, 2);
    assert.match(parts[0].text ?? "", /画像2/);
    assert.deepEqual(
      [stats.attempted, stats.succeeded, stats.skipped],
      [2, 1, 1],
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("origin未指定画像は直接添付として扱う", async () => {
  const { parts, stats } = await buildAffirmativeImageParts(
    [{ image_url: "https://example.com/1.png", mimeType: "image/png" }],
    "日本語",
    okFetch,
  );

  assert.match(parts[0].text ?? "", /直接添付/);
  assert.equal(stats.byOrigin.direct.succeeded, 1);
});
