import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { FortuneImageDeps } from "../src/features/fortuneImage.js";
import { composeFortuneImage } from "../src/features/fortuneImage.js";

const fortune = {
  fortune: "【今日の運勢】\n笑顔の日。\n\n【ラッキーフード】 カレー\n元気が出るから。",
  emojis: "🔮✨🍀",
  picture: "botたんが公園でカレーを食べている",
};

function png(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#88ccff";
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

function deps(result: Awaited<ReturnType<FortuneImageDeps["generateImage"]>>, available = true) {
  const calls: string[] = [];
  const value: FortuneImageDeps = {
    isImageGenerationAvailable: () => available,
    generateImage: async (source) => {
      calls.push(source);
      return result;
    },
  };
  return { calls, value };
}

test("描けたら占いの題材で描いた絵を背景にする", async () => {
  const generated = { data: png(832, 1216), mimeType: "image/png", width: 832, height: 1216 };
  const { calls, value } = deps(generated);

  const image = await composeFortuneImage(fortune, value, "test");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /公園でカレーを食べている/);
  assert.equal(image.background, generated);
  const decoded = await loadImage(image.data);
  assert.deepEqual([decoded.width, decoded.height], [832, 1216]);
});

test("画像生成が使えない・題材が無い・描けなかった・壊れていたら固定背景に戻す", async () => {
  const cases = [
    { label: "未設定", ...deps(null, false), input: fortune, expectCalls: 0 },
    { label: "題材なし", ...deps(null), input: { ...fortune, picture: "" }, expectCalls: 0 },
    { label: "描けなかった", ...deps(null), input: fortune, expectCalls: 1 },
    {
      label: "壊れた画像",
      ...deps({ data: Buffer.from([1, 2, 3]), mimeType: "image/png", width: 0, height: 0 }),
      input: fortune,
      expectCalls: 1,
    },
  ];

  for (const { label, calls, value, input, expectCalls } of cases) {
    const image = await composeFortuneImage(input, value, "test");
    assert.equal(calls.length, expectCalls, label);
    assert.equal(image.background, undefined, label);
    assert.equal(image.mimeType, "image/png", label);
    // 固定背景（bot-tan-fortune.png 1377px を半分に縮小）で合成されている。
    const decoded = await loadImage(image.data);
    assert.deepEqual([decoded.width, decoded.height], [688, 688], label);
  }
});
