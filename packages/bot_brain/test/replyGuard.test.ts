import assert from "node:assert/strict";
import { test } from "node:test";
import { DegenerateReplyError, assertUsableReply } from "../src/ai/replyGuard.js";

test("呼びかけ名をそのまま返した本文は投稿させない", () => {
  // 2026-08-31 の事故そのもの。コンテキストを使い切って表示名だけが出力された。
  assert.throws(
    () => assertUsableReply("Lisya Myata 🦊", "Lisya Myata 🦊", {}),
    DegenerateReplyError,
  );
});

test("敬称や句読点が付いただけの呼びかけも同じ扱いにする", () => {
  assert.throws(() => assertUsableReply("すいばりさん、", "すいばり", {}), DegenerateReplyError);
  assert.throws(() => assertUsableReply("すいばり！", "すいばりさん", {}), DegenerateReplyError);
});

test("呼びかけで始まる正常な返信は通す（誤検知させない）", () => {
  // ここが誤検知すると返信が黙って消える。部分一致で判定してはいけない。
  assert.doesNotThrow(() =>
    assertUsableReply("Lisya Myataさん、おはよう！", "Lisya Myata 🦊", {}),
  );
  assert.doesNotThrow(() =>
    assertUsableReply("すいばりさん、今日もえらいよ〜！💖", "すいばり", {}),
  );
});

test("短い相づちは切り詰めが起きていなければ通す", () => {
  assert.doesNotThrow(() => assertUsableReply("うんうん！", "すいばり", {}));
  assert.doesNotThrow(() => assertUsableReply("そうだね", "すいばり", { truncated: false }));
});

test("切り詰められたうえに極端に短い本文だけを弾く", () => {
  assert.throws(
    () => assertUsableReply("あ", "すいばり", { truncated: true }),
    DegenerateReplyError,
  );
  // 切り詰められていても十分な長さがあるなら投稿してよい。
  assert.doesNotThrow(() =>
    assertUsableReply("わあ、それすごいね！", "すいばり", { truncated: true }),
  );
});

test("空文字はこれまでどおり空エラーにする", () => {
  assert.throws(() => assertUsableReply("", "すいばり", {}), /Response text is empty/);
});

test("呼びかけ名が未設定でも落ちない", () => {
  assert.doesNotThrow(() => assertUsableReply("こんにちは！", undefined, {}));
});

test("生の構造化 JSON やエスケープされた改行の連続は投稿させない", () => {
  // 2026-09-16 の事故。`{"reply": "…\\n\\n\\n…` がそのまま4連投された。
  assert.throws(
    () => assertUsableReply('{"reply": "湖底、おやすみなさい！', "湖底", {}),
    DegenerateReplyError,
  );
  assert.throws(
    () => assertUsableReply("おやすみ！" + "\\n".repeat(10), "湖底", {}),
    DegenerateReplyError,
  );
  // 本物の改行や、波括弧を含むだけの返事は通す。
  assert.doesNotThrow(() => assertUsableReply("おやすみ！\n\nまたね{笑}", "湖底", {}));
});
