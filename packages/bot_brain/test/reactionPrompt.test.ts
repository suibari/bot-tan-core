import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { buildConversationPrompt } from "../src/ai/conversation.js";
import { buildAffirmativePrompt } from "../src/ai/generateAffirmativeWord.js";

const userinfo = (
  langStr: "日本語" | "English",
  extra: Partial<UserInfoGemini>,
): UserInfoGemini => ({
  follower: {
    did: "did:plc:test",
    handle: "test.example",
    displayName: "テスト",
  },
  posts: ["今日もいい日だったよ"],
  langStr,
  ...extra,
});

test("NagiのUnicodeリアクションをいいねに一般化せず肯定返信へ渡す", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo("日本語", { receivedNagiReaction: { emoji: "🌊" } }),
  );

  assert.match(prompt, /「🌊」の絵文字でリアクション/);
  assert.match(prompt, /「いいね」と言い換えず/);
});

test("Nagiのカスタム絵文字名を日英の肯定返信へ渡す", async () => {
  const reaction = {
    emoji: ":fallback_name:",
    customEmojiName: ":nagi_wave:",
  };
  const ja = await buildAffirmativePrompt(
    userinfo("日本語", { receivedNagiReaction: reaction }),
  );
  const en = await buildAffirmativePrompt(
    userinfo("English", { receivedNagiReaction: reaction }),
  );

  assert.match(ja, /カスタム絵文字「:nagi_wave:」/);
  assert.doesNotMatch(ja, /カスタム絵文字「:fallback_name:」/);
  assert.match(en, /custom emoji named :nagi_wave:/);
  assert.match(en, /do not call it a like/);
});

test("Nagiリアクションは会話モードにも同じ意味で渡す", () => {
  const unicode = buildConversationPrompt(
    userinfo("日本語", { receivedNagiReaction: { emoji: "🎉" } }),
  );
  const custom = buildConversationPrompt(
    userinfo("English", {
      receivedNagiReaction: {
        emoji: ":fallback_name:",
        customEmojiName: ":party_blob:",
      },
    }),
  );

  assert.match(unicode, /「🎉」の絵文字でリアクション/);
  assert.match(unicode, /「いいね」と言い換えず/);
  assert.match(custom, /custom emoji named :party_blob:/);
  assert.match(custom, /do not call it a like/);
});

test("Blueskyの既存いいね指示はNagiリアクションと分離して維持する", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo("日本語", { likedByFollower: ["botたんの投稿"] }),
  );

  assert.match(prompt, /ユーザがあなたの投稿にイイネしてくれた/);
  assert.doesNotMatch(prompt, /Nagiであなたの投稿に/);
});
