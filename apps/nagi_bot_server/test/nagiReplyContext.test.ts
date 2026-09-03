import assert from "node:assert/strict";
import test from "node:test";
import { receivedNagiReaction } from "../src/nagiReplyContext.js";

test("Unicodeリアクションは文字そのものを返す", () => {
  assert.deepEqual(
    receivedNagiReaction({ emoji: "🌊", emojiUri: null, emojiName: null }),
    { emoji: "🌊" },
  );
});

test("カスタム絵文字は参照先の正規nameを優先する", () => {
  assert.deepEqual(
    receivedNagiReaction({
      emoji: ":record_fallback:",
      emojiUri: "at://did:plc:emoji/blue.moji.collection.item/one",
      emojiName: ":canonical_name:",
    }),
    { emoji: ":record_fallback:", customEmojiName: ":canonical_name:" },
  );
});

test("参照先nameを取得できないカスタム絵文字はレコード値へフォールバックする", () => {
  assert.deepEqual(
    receivedNagiReaction({
      emoji: ":fallback_name:",
      emojiUri: "at://did:plc:emoji/blue.moji.collection.item/missing",
      emojiName: null,
    }),
    { emoji: ":fallback_name:", customEmojiName: ":fallback_name:" },
  );
});
