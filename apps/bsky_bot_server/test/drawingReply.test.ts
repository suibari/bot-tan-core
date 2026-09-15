import assert from "node:assert/strict";
import test from "node:test";
import { hasDrawingHint } from "@bsky-affirmative-bot/shared-configs";
import { drawingReplyText } from "../src/features/drawingReply.js";

test("絵の話をしている投稿だけを LLM の判定へ回す", () => {
  for (const text of ["botたん、猫の絵描いて！", "なにかイラストかいてほしいな", "Bot-tan, draw me a cat"]) {
    assert.equal(hasDrawingHint(text), true, text);
  }
  for (const text of ["botたんおはよう", "DJお願い", "分析して"]) {
    assert.equal(hasDrawingHint(text), false, text);
  }
});

test("描いた絵のリプライは題材を添え、日本語以外は英語で返す", () => {
  const ja = drawingReplyText("drawn", { langStr: "日本語", name: "すいぱり", subject: "猫" });
  assert.match(ja, /すいぱりさん/);
  assert.match(ja, /「猫」/);

  const en = drawingReplyText("drawn", { langStr: "English", name: "suibari", subject: "a cat" });
  assert.match(en, /"a cat"/);
  assert.doesNotMatch(en, /[ぁ-ん]/);
  assert.doesNotMatch(ja, /1日1回|また明日/);
  assert.doesNotMatch(en, /once a day|tomorrow/i);
});

test("すべての結果に日英の本文がある", () => {
  for (const kind of ["drawn", "declined", "user_limit", "service_limit", "failed"] as const) {
    for (const langStr of ["日本語", "English"]) {
      assert.ok(drawingReplyText(kind, { langStr, name: "name", subject: "猫" }).length > 0);
    }
  }
});
