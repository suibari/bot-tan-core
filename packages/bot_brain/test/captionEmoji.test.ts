import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  buildEmojiCaptionMessages,
  captionEmoji,
  parseEmojiCaption,
} from "../src/ai/captionEmoji.js";
import { prepareModelImages } from "../src/ai/imagePreprocess.js";

/** 透過背景に黒い四角を描いた 128px の絵文字。 */
function transparentEmoji(): Buffer {
  const canvas = createCanvas(128, 128);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(32, 32, 64, 64);
  return canvas.toBuffer("image/png");
}

test("読み取り結果を検証し、長さと個数を丸める", () => {
  assert.deepEqual(
    parseEmojiCaption(
      JSON.stringify({
        text: " 解散 ",
        description: "青い文字",
        keywords: ["終わり", "終わり", "", 3, ...Array.from({ length: 10 }, (_, i) => `語${i}`)],
      }),
    ),
    {
      text: "解散",
      description: "青い文字",
      keywords: ["終わり", "語0", "語1", "語2", "語3", "語4", "語5", "語6"],
    },
  );
  assert.deepEqual(parseEmojiCaption("{}"), { text: "", description: "", keywords: [] });
  for (const raw of ["", "not json", "null", "1"]) assert.equal(parseEmojiCaption(raw), null, raw);
});

test("名前と説明を添え、画像は指示の後ろに置く", async () => {
  const messages = await buildEmojiCaptionMessages({
    name: ":zannen:",
    alt: "がっかり",
    image: { buffer: transparentEmoji(), mimeType: "image/png" },
  });
  assert.equal(messages[0].role, "system");
  assert.equal(messages.at(-1)!.role, "user");
  assert.match(messages.at(-1)!.content, /^名前: zannen\n説明: がっかり$/);
  assert.equal(messages.at(-1)!.images?.length, 1);
});

test("壊れた画像は名前だけで読ませる", async () => {
  const messages = await buildEmojiCaptionMessages({
    name: ":dame:",
    image: { buffer: Buffer.from([1, 2, 3]), mimeType: "image/png" },
  });
  assert.equal(messages.at(-1)!.images, undefined);
  assert.match(messages.at(-1)!.content, /画像は読み込めなかった/);
});

test("小さい絵文字は拡大し、透過部分は白で塗る", async () => {
  const [image] = await prepareModelImages(transparentEmoji(), "image/png", {
    minLongSide: 512,
    background: "#ffffff",
  });
  const decoded = await loadImage(Buffer.from(image.data, "base64"));
  assert.equal(decoded.width, 512);
  const canvas = createCanvas(decoded.width, decoded.height);
  const context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  // JPEG の既定だと透過は黒になり、黒い文字が背景に溶ける。
  const [r, g, b] = context.getImageData(4, 4, 1, 1).data;
  assert.ok(r > 240 && g > 240 && b > 240, `corner is ${r},${g},${b}`);
  const [cr] = context.getImageData(256, 256, 1, 1).data;
  assert.ok(cr < 20, `center is ${cr}`);
});

test("指定が無ければ小さい画像を拡大しない", async () => {
  const [image] = await prepareModelImages(transparentEmoji(), "image/png");
  const decoded = await loadImage(Buffer.from(image.data, "base64"));
  assert.equal(decoded.width, 128);
});

test("Ollama へ num_ctx を送らず、temperature と num_predict を送る", async () => {
  const previous = {
    base: process.env.OLLAMA_BASE_URL,
    model: process.env.OLLAMA_MODEL,
  };
  process.env.OLLAMA_BASE_URL = "http://ollama.test/v1";
  process.env.OLLAMA_MODEL = "test-model";
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({
      message: { content: '{"text":"残念","description":"文字","keywords":["がっかり"]}' },
    }),
  );
  try {
    const caption = await captionEmoji({ name: ":zannen:" });
    assert.deepEqual(caption, { text: "残念", description: "文字", keywords: ["がっかり"] });
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "http://ollama.test/api/chat");
    const body = JSON.parse(String(init.body));
    assert.equal(body.options.num_ctx, undefined);
    assert.equal(typeof body.options.temperature, "number");
    assert.equal(typeof body.options.num_predict, "number");
    assert.equal(body.think, false);
    assert.ok(body.format);
  } finally {
    fetchMock.mock.restore();
    for (const [key, value] of [
      ["OLLAMA_BASE_URL", previous.base],
      ["OLLAMA_MODEL", previous.model],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
