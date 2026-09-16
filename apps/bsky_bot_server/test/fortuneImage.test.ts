import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { textToImageBufferWithGeneratedBackground } from "../src/util/canvas.js";

const TEXT = [
  "【今日の運勢】",
  "冒険と笑いが重なる日。".repeat(8),
  "",
  "【ラッキーフード】 麻婆カレー",
  "辛さが元気をくれるから。",
].join("\n");

function noiseBackground(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = Math.random() * 255;
    image.data[index + 1] = Math.random() * 255;
    image.data[index + 2] = Math.random() * 255;
    image.data[index + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

test("生成した絵の寸法のまま本文を重ね、blob 上限に収める", async () => {
  // ノイズの PNG は圧縮が効かず、そのままでは上限を超える。JPEG へ落ちることを確かめる。
  const background = noiseBackground(832, 1216);
  assert.ok(background.byteLength > 950_000);

  const result = await textToImageBufferWithGeneratedBackground(TEXT, background, 950_000);
  assert.ok(result.data.byteLength <= 950_000, `${result.data.byteLength}B`);
  assert.equal(result.mimeType, "image/jpeg");

  const decoded = await loadImage(result.data);
  assert.equal(decoded.width, 832);
  assert.equal(decoded.height, 1216);
});

test("右下のサインの帯と上側の絵にはパネルを重ねない", async () => {
  const canvas = createCanvas(832, 1216);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(0, 0, 0)";
  ctx.fillRect(0, 0, 832, 1216);

  const result = await textToImageBufferWithGeneratedBackground(TEXT, canvas.toBuffer("image/png"), 950_000);
  assert.equal(result.mimeType, "image/png");

  const decoded = await loadImage(result.data);
  const check = createCanvas(832, 1216);
  const checkCtx = check.getContext("2d");
  checkCtx.drawImage(decoded, 0, 0);
  const pixel = (x: number, y: number) => Array.from(checkCtx.getImageData(x, y, 1, 1).data.slice(0, 3));

  assert.deepEqual(pixel(416, 20), [0, 0, 0], "上端は絵のまま");
  assert.deepEqual(pixel(800, 1200), [0, 0, 0], "サインの帯は絵のまま");
  const [r] = pixel(60, 1216 - Math.round(1216 * 0.15) - 60);
  assert.ok(r > 150, "パネルは下寄せ");
});

test("壊れた背景は reject する（呼び出し側が固定背景へ戻す）", async () => {
  await assert.rejects(textToImageBufferWithGeneratedBackground(TEXT, Buffer.from([1, 2, 3]), 950_000));
});
