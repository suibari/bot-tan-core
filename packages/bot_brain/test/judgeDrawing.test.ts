import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DRAWING_SUBJECT,
  normalizeDrawingGift,
  normalizeDrawingRequest,
} from "../src/ai/judgeDrawing.js";

/**
 * 判定モデルの出力を受け取る側の防御。絵は GPU を占有し、投稿した絵は取り消せないので、
 * 迷ったら描かない側へ倒す。ここはその「倒す」条件を固定する。
 */

const request = {
  addressee: "bot",
  intent: "request",
  subject: "猫",
  concern: "none",
  confidence: 0.9,
};

test("botたん宛ての依頼で確信度が十分なら描く", () => {
  assert.deepEqual(normalizeDrawingRequest(request), {
    intent: "request",
    allowed: true,
    subject: "猫",
  });
});

test("botたん以外への依頼や依頼でない投稿は描かない", () => {
  for (const addressee of ["other", "none", undefined]) {
    assert.equal(normalizeDrawingRequest({ ...request, addressee }).intent, "none");
  }
  assert.equal(normalizeDrawingRequest({ ...request, intent: "none" }).intent, "none");
  assert.equal(normalizeDrawingRequest(null).intent, "none");
});

test("確信度が低い依頼は描かない", () => {
  assert.equal(normalizeDrawingRequest({ ...request, confidence: 0.6 }).intent, "none");
  assert.equal(normalizeDrawingRequest({ ...request, confidence: "0.9" }).intent, "none");
});

test("問題のある依頼や知らない concern は断る側に倒す", () => {
  for (const concern of ["sexual", "violence", "real_person", "existing_character", "unknown", undefined]) {
    const result = normalizeDrawingRequest({ ...request, concern });
    assert.equal(result.intent, "request");
    assert.equal(result.intent === "request" && result.allowed, false, `concern=${concern} が通ってしまう`);
  }
});

test("題材が空や null 文字列なら既定の題材で描き、改行と長さは整える", () => {
  for (const subject of ["", "  ", "null", "なし", undefined]) {
    const result = normalizeDrawingRequest({ ...request, subject });
    assert.equal(result.intent === "request" && result.subject, DEFAULT_DRAWING_SUBJECT);
  }
  const multiline = normalizeDrawingRequest({ ...request, subject: "桜と\n  お団子" });
  assert.equal(multiline.intent === "request" && multiline.subject, "桜と お団子");
  const long = normalizeDrawingRequest({ ...request, subject: "あ".repeat(100) });
  assert.equal(long.intent === "request" && long.subject.length, 60);
});

const gift = {
  mood: "very_happy",
  intensity: 0.9,
  crisis: false,
  scene: "botたんが桜の木の下でケーキを持って一緒に喜んでいる",
};

test("気持ちが大きく動いていれば、判定が書いた場面で贈る", () => {
  assert.deepEqual(normalizeDrawingGift(gift), { gift: true, mood: "very_happy", scene: gift.scene });
  assert.equal(normalizeDrawingGift({ ...gift, mood: "very_down" }).gift, true);
});

test("ふつうの日常や弱い気持ちには贈らない", () => {
  assert.equal(normalizeDrawingGift({ ...gift, mood: "other" }).gift, false);
  assert.equal(normalizeDrawingGift({ ...gift, intensity: 0.7 }).gift, false);
  assert.equal(normalizeDrawingGift({ ...gift, intensity: undefined }).gift, false);
});

test("危機の打ち明けには贈らない（欠落も危機ではないと読まない）", () => {
  assert.equal(normalizeDrawingGift({ ...gift, mood: "very_down", crisis: true }).gift, false);
  assert.equal(normalizeDrawingGift({ ...gift, crisis: undefined }).gift, false);
});

test("場面が書かれていなければ贈らない（投稿本文をそのまま絵にしない）", () => {
  for (const scene of ["", "null", undefined]) {
    assert.equal(normalizeDrawingGift({ ...gift, scene }).gift, false);
  }
});
