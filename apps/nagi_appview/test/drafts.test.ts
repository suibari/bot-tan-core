import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";

const { parseDraftContent } = await import("../src/queries/drafts.js");

const valid = () => ({
  text: "hello",
  mentions: [{ start: 0, end: 1, did: "did:plc:alice", handle: "alice.test" }],
  emojis: [
    { start: 2, end: 3, uri: "at://did:plc:a/blue.moji.collection/one" },
  ],
  linkCards: [
    { uri: "https://example.com", title: "Example", description: "Saved text" },
  ],
  dismissedUrls: [],
});

test("下書きはバイナリを持たずテキスト参照だけを受理する", () => {
  assert.deepEqual(parseDraftContent(valid()), valid());
  for (const extra of [
    { images: [] },
    {
      linkCards: [
        { uri: "https://example.com", title: "x", thumbnail: "bytes" },
      ],
    },
    { dismissedUrls: ["data:image/png;base64,abc"] },
  ])
    assert.throws(() => parseDraftContent({ ...valid(), ...extra }));
});

test("廃止したチャンネルの選択は旧クライアントから届いても保存しない", () => {
  const legacy = {
    ...valid(),
    channels: [
      {
        start: 1,
        end: 2,
        uri: "at://did:plc:a/com.suibari.nagi.channel/one",
        name: "one",
      },
    ],
  };
  assert.deepEqual(parseDraftContent(legacy), valid());
});

test("ブログ用の長い下書きは3,000文字を超えても受理する", () => {
  const content = { ...valid(), text: "長".repeat(3_001) };
  assert.deepEqual(parseDraftContent(content), content);
});
