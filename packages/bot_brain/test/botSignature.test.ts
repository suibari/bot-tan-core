import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { applyBotSignature, chooseSignatureColor } from "../src/ai/botSignature.js";

function solidPng(width: number, height: number, color: string): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

test("サインを小さく右下へ置き、生成画像の寸法を保つ", async () => {
  const width = 600;
  const height = 800;
  const result = await applyBotSignature({
    data: solidPng(width, height, "#f4d2a0"),
    mimeType: "image/png",
    width,
    height,
  });

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.width, width);
  assert.equal(result.height, height);

  const decoded = await loadImage(result.data);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (pixels[index] === 244 && pixels[index + 1] === 210 && pixels[index + 2] === 160) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  assert.ok(maxX >= 0, "サインで変化した画素があること");
  assert.ok(minX > width * 0.7, `サインの左端 ${minX} が右側にあること`);
  assert.ok(minY > height * 0.75, `サインの上端 ${minY} が下側にあること`);
  assert.ok(maxX < width - 5 && maxY < height - 5, "画像端との余白を残すこと");
});

test("絵の代表色を使い、置き場所が明るければ濃い色にする", () => {
  const orange = new Uint8ClampedArray([230, 130, 45, 255, 220, 110, 35, 255]);
  const color = chooseSignatureColor(orange, 0.9);
  assert.ok(color.r > color.g && color.g > color.b, `暖色を保つこと: ${JSON.stringify(color)}`);
  assert.ok(color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 < 128);
});

test("暗い絵では同じ色相の明るいサインにする", () => {
  const blue = new Uint8ClampedArray([35, 90, 220, 255, 45, 105, 230, 255]);
  const color = chooseSignatureColor(blue, 0.1);
  assert.ok(color.b > color.g && color.g > color.r, `青系を保つこと: ${JSON.stringify(color)}`);
  assert.ok(color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 > 128);
});

test("無彩色の絵へ存在しない色相を足さない", () => {
  const gray = new Uint8ClampedArray([120, 120, 120, 255, 210, 210, 210, 255]);
  const color = chooseSignatureColor(gray, 0.9);
  assert.ok(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 1);
});

test("上限を超えるPNGは寸法を保ったWebPへ圧縮する", async () => {
  const width = 512;
  const height = 512;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(width, height);
  let random = 0x12345678;
  for (let index = 0; index < pixels.data.length; index += 4) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    pixels.data[index] = random & 0xff;
    pixels.data[index + 1] = (random >>> 8) & 0xff;
    pixels.data[index + 2] = (random >>> 16) & 0xff;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);

  const result = await applyBotSignature(
    { data: canvas.toBuffer("image/png"), mimeType: "image/png", width, height },
    100_000,
  );
  assert.equal(result.mimeType, "image/webp");
  assert.ok(result.data.byteLength <= 100_000);
  const decoded = await loadImage(result.data);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width, height });
});

test("容量に余裕があるWebPを極端な低品質で再圧縮しない", async () => {
  const width = 256;
  const height = 256;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(width, height);
  let random = 0x87654321;
  for (let index = 0; index < pixels.data.length; index += 4) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    pixels.data[index] = random & 0xff;
    pixels.data[index + 1] = (random >>> 8) & 0xff;
    pixels.data[index + 2] = (random >>> 16) & 0xff;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const result = await applyBotSignature({
    data: canvas.toBuffer("image/png"),
    mimeType: "image/webp",
    width,
    height,
  });

  // 旧実装は quality=0.9（約1%）と解釈され、この入力を約12KBまで潰していた。
  assert.ok(result.data.byteLength > 50_000, `高品質WebPであること: ${result.data.byteLength} bytes`);
});
