import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DRAWING_SUBJECT,
  DRAWING_GIFT_SYSTEM,
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
    concern: "none",
    subject: "猫",
  });
});

test("既存作品の架空キャラクターは描く", () => {
  assert.deepEqual(
    normalizeDrawingRequest({
      ...request,
      subject: "スタックチャン",
      concern: "existing_character",
    }),
    {
      intent: "request",
      allowed: true,
      concern: "existing_character",
      subject: "スタックチャン",
    },
  );
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
  for (const concern of ["sexual", "violence", "hate", "real_person", "self_harm", "unknown", undefined]) {
    const result = normalizeDrawingRequest({ ...request, concern });
    assert.equal(result.intent, "request");
    assert.equal(result.intent === "request" && result.allowed, false, `concern=${concern} が通ってしまう`);
    assert.equal(result.intent === "request" && result.concern, concern ?? "unknown");
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

test("贈り物の場面は元投稿の主題と添付画像の架空キャラクターを引き継ぐ", () => {
  assert.match(DRAWING_GIFT_SYSTEM, /投稿の中心.*必ず場面の主題/);
  assert.match(DRAWING_GIFT_SYSTEM, /キャラクター名と作品名を正確に書き/);
  assert.match(DRAWING_GIFT_SYSTEM, /ガチャ.*そのキャラクターとbotたん/);
  assert.doesNotMatch(DRAWING_GIFT_SYSTEM, /作品のキャラクター名は入れない/);
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

test("参考画像の場面は短い題名と別に保持し、読み取り結果が空なら描かない", () => {
  const scene = "botたんが海辺で赤い傘を持ち、左を向いて座っている。夕日が右奥に見える。".repeat(3);
  assert.deepEqual(normalizeDrawingRequest({ ...request, scene }, true), {
    intent: "request", allowed: true, concern: "none", subject: "猫", scene,
  });
  assert.deepEqual(normalizeDrawingRequest(request, true), { intent: "unavailable" });
  const declined = normalizeDrawingRequest({ ...request, concern: "real_person" }, true);
  assert.equal(declined.intent === "request" && declined.allowed, false);
});

test("画像付き依頼は整形した画像を判定へ渡し、取得・デコード・推論失敗時は題材を捏造しない", async (t) => {
  const { judgeDrawingRequest } = await import("../src/ai/judgeDrawing.js");
  const { createCanvas } = await import("@napi-rs/canvas");
  const original = process.env.OLLAMA_BASE_URL;
  const originalModel = process.env.OLLAMA_MODEL;
  process.env.OLLAMA_MODEL = "test-model";
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434/v1";
  const png = createCanvas(32, 32).toBuffer("image/png");
  const images = [{ image_url: "https://93.184.216.34/reference.png", mimeType: "image/png" }];
  let mode = "ok";
  let body: any;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
    if (String(url).includes("reference.png")) {
      if (mode === "http") return new Response("missing", { status: 404 });
      return new Response(mode === "broken" ? new Uint8Array([1, 2, 3]) : new Uint8Array(png));
    }
    calls++;
    body = JSON.parse(init.body);
    if (mode === "model") throw new Error("model unavailable");
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ ...request, scene: "海辺で赤い傘を持つbotたん" }) } }));
  });
  try {
    const result = await judgeDrawingRequest("botたん、こういうのを描いて", images);
    assert.equal(result.intent === "request" && result.scene, "海辺で赤い傘を持つbotたん");
    assert.ok(body.messages[1].images.length > 0);
    assert.notEqual(body.messages[1].images[0], png.toString("base64"));
    assert.match(body.messages.at(-1).content, /こういうのを描いて$/);
    assert.equal("num_ctx" in body.options, false);
    assert.equal(typeof body.options.num_predict, "number");
    assert.equal(typeof body.options.temperature, "number");
    for (mode of ["http", "broken"]) {
      assert.deepEqual(await judgeDrawingRequest("botたん、これ描いて", images), { intent: "unavailable" });
    }
    assert.equal(calls, 1);
    mode = "model";
    assert.deepEqual(await judgeDrawingRequest("botたん、これ描いて", images), { intent: "unavailable" });
    mode = "ok";
    await judgeDrawingRequest("botたん、猫描いて");
    assert.equal(body.messages[1].images, undefined);
  } finally {
    if (original === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = original;
    if (originalModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = originalModel;
  }
});
