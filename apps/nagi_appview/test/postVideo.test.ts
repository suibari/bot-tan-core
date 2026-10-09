import assert from "node:assert/strict";
import test from "node:test";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { validateRecord } from "../src/ingest/validateRecord.js";
import { postVideoView } from "../src/queries/postVideo.js";
import { moderationSubject } from "../src/services/moderation/subject.js";
import { postPushBody } from "../src/services/pushPayload.js";

const DID = "did:plc:author";
const CID = "bafkreivideo";
const blob = (overrides: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: CID },
  mimeType: "video/mp4",
  size: 1_000_000,
  ...overrides,
});
const video = (overrides: Record<string, unknown> = {}) => ({
  video: blob(),
  alt: "猫が走る",
  aspectRatio: { width: 16, height: 9 },
  ...overrides,
});
const image = {
  image: { ref: { $link: "bafyimage" }, mimeType: "image/png", size: 10 },
  alt: "",
};
const post = (embed: unknown) => ({
  $type: NAGI.post,
  text: "見て",
  createdAt: "2026-10-09T00:00:00.000Z",
  embed,
});
const quoteRef = { uri: `at://${DID}/${NAGI.post}/abc`, cid: "bafyquote" };

test("#video の投稿を受け付ける", () => {
  assert.equal(validateRecord(NAGI.post, post({ $type: `${NAGI.post}#video`, ...video() })), true);
  assert.equal(
    validateRecord(NAGI.post, post({ $type: `${NAGI.post}#video`, video: blob() })),
    true,
    "alt は任意",
  );
});

test("mp4 以外・100MB 超・壊れた aspectRatio の動画は捨てる", () => {
  for (const bad of [
    video({ video: blob({ mimeType: "video/webm" }) }),
    video({ video: blob({ size: 100_000_001 }) }),
    video({ aspectRatio: { width: 0, height: 9 } }),
    video({ alt: 1 }),
  ])
    assert.equal(validateRecord(NAGI.post, post({ $type: `${NAGI.post}#video`, ...bad })), false);
});

test("引用には動画を付けられるが、画像とは同時に付けられない", () => {
  assert.equal(
    validateRecord(NAGI.post, post({ $type: `${NAGI.post}#quote`, record: quoteRef, video: video() })),
    true,
  );
  assert.equal(
    validateRecord(
      NAGI.post,
      post({ $type: `${NAGI.post}#quote`, record: quoteRef, video: video(), images: [image] }),
    ),
    false,
  );
});

test("ビューは video.bsky.app の HLS とサムネイルを指す", () => {
  assert.deepEqual(postVideoView(DID, video({ contentWarning: true })), {
    playlist: `https://video.bsky.app/watch/did%3Aplc%3Aauthor/${CID}/playlist.m3u8`,
    thumbnail: `https://video.bsky.app/watch/did%3Aplc%3Aauthor/${CID}/thumbnail.jpg`,
    alt: "猫が走る",
    contentWarning: true,
    aspectRatio: { width: 16, height: 9 },
  });
  assert.equal(postVideoView(DID, null), undefined);
  assert.equal(postVideoView(DID, { video: {} }), undefined);
});

test("モデレーションには動画のサムネイルと alt を渡す", () => {
  const direct = moderationSubject(NAGI.post, post({ $type: `${NAGI.post}#video`, ...video() }), DID)!;
  assert.deepEqual(direct.texts, ["見て", "猫が走る"]);
  assert.deepEqual(direct.imageUrls, [
    `https://video.bsky.app/watch/did%3Aplc%3Aauthor/${CID}/thumbnail.jpg`,
  ]);
  const quoted = moderationSubject(
    NAGI.post,
    post({ $type: `${NAGI.post}#quote`, record: quoteRef, video: video() }),
    DID,
  )!;
  assert.equal(quoted.imageUrls.length, 1);
});

test("本文の無い動画投稿の通知は添付の種類を伝える", () => {
  assert.equal(postPushBody({ text: "", hasVideo: true }), "動画付きの投稿");
});

const galleryImage = { $type: `${NAGI.post}#image`, ...image };
const galleryVideo = (overrides: Record<string, unknown> = {}) => ({
  $type: `${NAGI.post}#video`,
  ...video(overrides),
});
const gallery = (items: unknown[]) => post({ $type: `${NAGI.post}#gallery`, items });

test("#gallery は画像と動画を1投稿に混ぜられる", () => {
  assert.equal(validateRecord(NAGI.post, gallery([galleryImage, galleryVideo()])), true);
  assert.equal(
    validateRecord(NAGI.post, gallery([galleryVideo(), galleryImage, galleryImage, galleryImage, galleryImage])),
    true,
    "画像4枚＋動画1本まで",
  );
});

test("#gallery の上限・型・中身の崩れは捨てる", () => {
  for (const items of [
    [],
    [galleryVideo(), galleryVideo()],
    [galleryImage, galleryImage, galleryImage, galleryImage, galleryImage],
    [image],
    [{ $type: `${NAGI.post}#quote`, record: quoteRef }],
    [galleryImage, galleryVideo({ video: blob({ mimeType: "video/webm" }) })],
  ])
    assert.equal(validateRecord(NAGI.post, gallery(items)), false);
  assert.equal(
    validateRecord(NAGI.post, post({ $type: `${NAGI.post}#gallery` })),
    false,
    "items は必須",
  );
});

test("モデレーションは #gallery の画像と動画の両方を見る", () => {
  const subject = moderationSubject(NAGI.post, gallery([galleryImage, galleryVideo()]), DID)!;
  assert.deepEqual(subject.texts, ["見て", "", "猫が走る"].filter(Boolean));
  assert.equal(subject.imageUrls.length, 2);
  assert.equal(subject.imageUrls[1], `https://video.bsky.app/watch/did%3Aplc%3Aauthor/${CID}/thumbnail.jpg`);
});
