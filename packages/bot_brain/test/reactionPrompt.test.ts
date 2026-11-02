import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { buildConversationPrompt } from "../src/ai/conversation.js";
import { buildAffirmativePrompt } from "../src/ai/generateAffirmativeWord.js";
import {
  NAGI_REACTION_NETA_EVERY,
  NAGI_REACTION_REPEAT_MENTION_EVERY,
  nagiReactionNetaEvery,
  nagiReactionInstruction,
  nagiReactionMode,
  shouldMentionNagiReaction,
} from "../src/ai/nagiReactionPrompt.js";
import { CARE_ANGLES } from "../src/ai/careAngles.js";

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
  assert.match(en, /do not call it a like/i);
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
  assert.match(unicode, /今回の返信では、この絵文字にひとこと触れて/);
  assert.match(custom, /custom emoji named :party_blob:/);
  assert.match(custom, /do not call it a like/i);
});

test("Blueskyの既存いいね指示はNagiリアクションと分離して維持する", async () => {
  const prompt = await buildAffirmativePrompt(
    userinfo("日本語", { likedByFollower: ["botたんの投稿"] }),
  );

  assert.match(prompt, /ユーザがあなたの投稿にイイネしてくれた/);
  assert.doesNotMatch(prompt, /Nagiであなたの投稿に/);
});

test("絵文字の意味の資料と感謝に偏らない指示を肯定・会話の日英へ渡す", async () => {
  for (const lang of ["日本語", "English"] as const) {
    const info = userinfo(lang, {
      receivedNagiReaction: {
        emoji: ":otsukare:",
        customEmojiName: ":otsukare:",
        customEmojiAlt: "お茶を差し出すねこ",
        customEmojiSearchText: "おつかれさま ねぎらい お茶",
      },
    });
    for (const prompt of [await buildAffirmativePrompt(info), buildConversationPrompt(info)]) {
      assert.match(prompt, /お茶を差し出すねこ/);
      assert.match(prompt, /おつかれさま ねぎらい お茶/);
      assert.match(prompt, lang === "日本語" ? /今回の返信では、この絵文字にひとこと触れて/ : /include a brief remark about this emoji/);
      // 触れること自体を任意にする一般論は置かない（#138 で言及が 21/47 → 3/56 に落ちた）。
      assert.doesNotMatch(prompt, /名前を本文にそのまま出す必要もありません|自然につながるひとことに留めて|need not repeat the shortcode/);
      assert.match(prompt, lang === "日本語" ? /見た目や由来を捏造せず/ : /without inventing an appearance or origin/);
    }
  }
});

test("触れる回だけ指示を渡し、沈んだ投稿では肯定返信に渡さない", async () => {
  const info = userinfo("日本語", {
    receivedNagiReaction: { emoji: ":thx:", customEmojiName: ":thx:" },
  });
  assert.match(await buildAffirmativePrompt(info), /カスタム絵文字「:thx:」/);
  const sinking = await buildAffirmativePrompt(info, { careAngle: CARE_ANGLES[0] });
  assert.doesNotMatch(sinking, /Nagiであなたの投稿に/);
});

test("気分採点のある肯定返信では重い話の省略をプロンプトに委ねず、会話では委ねる", async () => {
  const info = userinfo("日本語", { receivedNagiReaction: { emoji: "🎉" } });
  assert.doesNotMatch(await buildAffirmativePrompt(info), /重い話のときは、絵文字には触れず/);
  assert.match(buildConversationPrompt(info), /重い話のときは、絵文字には触れず/);
});

test("同じ絵文字の繰り返しは投稿ごとに決まった一部の回だけ触れる", () => {
  const decisions = Array.from({ length: 400 }, (_, index) =>
    shouldMentionNagiReaction({
      ...userinfo("日本語", {
        receivedNagiReaction: { emoji: ":thx:", customEmojiName: ":thx:", repeated: true },
      }),
      posts: [`今日もいい日だったよ ${index}`],
    }),
  );
  const mentioned = decisions.filter(Boolean).length;
  const expected = 400 / NAGI_REACTION_REPEAT_MENTION_EVERY;
  assert.ok(mentioned > expected * 0.6 && mentioned < expected * 1.4, `mentioned=${mentioned}`);

  // 再試行しても同じ判断になる。
  const again = userinfo("日本語", {
    receivedNagiReaction: { emoji: ":thx:", customEmojiName: ":thx:", repeated: true },
  });
  assert.equal(shouldMentionNagiReaction(again), shouldMentionNagiReaction(again));
  // 繰り返しでなければ必ず触れる。
  assert.equal(
    shouldMentionNagiReaction(userinfo("日本語", { receivedNagiReaction: { emoji: ":thx:", customEmojiName: ":thx:" } })),
    true,
  );
});

test("触れる回の一部だけ絵文字ネタにし、演出札を引いた回と会話モードではネタにしない", () => {
  const infoFor = (index: number) => ({
    ...userinfo("日本語", {
      receivedNagiReaction: { emoji: ":bot-tan_duel:", customEmojiName: ":bot-tan_duel:" },
    }),
    posts: [`今日のラーメンうまかった ${index}`],
  });
  const modes = Array.from({ length: 300 }, (_, index) =>
    nagiReactionMode(infoFor(index), { moodScored: true }),
  );
  const neta = modes.filter((mode) => mode === "neta").length;
  const expected = 300 / NAGI_REACTION_NETA_EVERY;
  assert.ok(neta > expected * 0.6 && neta < expected * 1.4, `neta=${neta}`);
  assert.ok(modes.every((mode) => mode !== "none"));

  const netaIndex = modes.indexOf("neta");
  assert.equal(nagiReactionMode(infoFor(netaIndex), { moodScored: true, netaDrawn: true }), "mention");
  assert.equal(nagiReactionMode(infoFor(netaIndex), {}), "mention");
  assert.equal(nagiReactionMode(infoFor(netaIndex), { moodScored: true, sinking: true }), "none");

  const ja = nagiReactionInstruction(infoFor(netaIndex), true, { moodScored: true });
  assert.match(ja, /この絵文字をネタにして1文だけ/);
  assert.match(ja, /デュエルを挑む/);
  assert.match(ja, /茶化したり皮肉ったりせず/);
  const en = nagiReactionInstruction(infoFor(netaIndex), false, { moodScored: true });
  assert.match(en, /one-sentence playful bit/);
});

test("絵文字ネタの間隔は環境変数で上書きでき、不正値は既定に戻す", () => {
  assert.equal(nagiReactionNetaEvery({}), NAGI_REACTION_NETA_EVERY);
  assert.equal(nagiReactionNetaEvery({ AI_NAGI_REACTION_NETA_EVERY: "0" }), 0);
  assert.equal(nagiReactionNetaEvery({ AI_NAGI_REACTION_NETA_EVERY: "1" }), 1);
  assert.equal(nagiReactionNetaEvery({ AI_NAGI_REACTION_NETA_EVERY: "-2" }), NAGI_REACTION_NETA_EVERY);
  assert.equal(nagiReactionNetaEvery({ AI_NAGI_REACTION_NETA_EVERY: "abc" }), NAGI_REACTION_NETA_EVERY);
});
