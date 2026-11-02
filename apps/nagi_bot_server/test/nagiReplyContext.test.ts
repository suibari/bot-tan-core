import assert from "node:assert/strict";
import test from "node:test";
import { db, nagiReactions } from "@bsky-affirmative-bot/database";
import { and } from "drizzle-orm";
import {
  isRepeatedNagiReaction,
  nagiReactionWindowConditions,
  receivedNagiReaction,
} from "../src/nagiReplyContext.js";

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

test("リアクションは前回返信後から今回返信までの1件だけを候補にする", () => {
  const previousReplyAt = new Date("2026-09-12T00:00:00.000Z");
  const currentReplyAt = new Date("2026-09-12T01:00:00.000Z");
  const query = db
    .select({ emoji: nagiReactions.emoji })
    .from(nagiReactions)
    .where(
      and(
        ...nagiReactionWindowConditions(currentReplyAt, previousReplyAt),
      ),
    )
    .toSQL();

  assert.match(query.sql, /"indexed_at" <= \$/);
  assert.match(query.sql, /"indexed_at" > \$/);
  assert.deepEqual(query.params, [
    currentReplyAt.toISOString(),
    previousReplyAt.toISOString(),
  ]);
  assert.ok(query.params.every((param) => !(param instanceof Date)));
});

test("初回返信でも今回より後のリアクションは拾わない", () => {
  const currentReplyAt = new Date("2026-09-12T01:00:00.000Z");
  const query = db
    .select({ emoji: nagiReactions.emoji })
    .from(nagiReactions)
    .where(and(...nagiReactionWindowConditions(currentReplyAt)))
    .toSQL();

  assert.match(query.sql, /"indexed_at" <= \$/);
  assert.doesNotMatch(query.sql, /"indexed_at" > \$/);
  assert.deepEqual(query.params, [currentReplyAt.toISOString()]);
});

test("カスタム絵文字の説明と画像由来の意味を返信へ渡す", () => {
  assert.deepEqual(receivedNagiReaction({
    emoji: ":tea:", emojiUri: "at://emoji/one", emojiName: ":tea:",
    emojiAlt: " お茶のねこ ", emojiSearchText: " おつかれさま ねぎらい ",
  }), {
    emoji: ":tea:", customEmojiName: ":tea:",
    customEmojiAlt: "お茶のねこ", customEmojiSearchText: "おつかれさま ねぎらい",
  });
});

test("前回の返信までにもらった最後のリアクションと同じ絵文字なら繰り返し扱いにする", () => {
  const thx = { emojiKey: "at://did:plc:emoji/blue.moji.collection.item/thx" };
  const good = { emojiKey: "at://did:plc:emoji/blue.moji.collection.item/good" };
  assert.equal(isRepeatedNagiReaction(thx, thx), true);
  assert.equal(isRepeatedNagiReaction(thx, good), false);
  assert.equal(isRepeatedNagiReaction(thx, undefined), false);
  assert.equal(isRepeatedNagiReaction(undefined, thx), false);
});

test("繰り返しのときだけ repeated を付けて返信へ渡す", () => {
  const row = { emoji: ":thx:", emojiUri: "at://emoji/thx", emojiName: ":thx:" };
  assert.deepEqual(receivedNagiReaction(row, { repeated: true }), {
    emoji: ":thx:", repeated: true, customEmojiName: ":thx:",
  });
  assert.equal("repeated" in receivedNagiReaction(row, { repeated: false })!, false);
});
