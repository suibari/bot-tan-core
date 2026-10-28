import assert from "node:assert/strict";
import test from "node:test";
import { loadImage } from "@napi-rs/canvas";
import { composeFortuneImage } from "../src/features/fortuneImage.js";

const fortune = {
  fortune: "【今日の運勢】\n笑顔の日。\n\n【ラッキーフード】 カレー\n元気が出るから。",
  emojis: "🔮✨🍀",
};

test("占い本文を固定背景に重ねる", async () => {
  const image = await composeFortuneImage(fortune);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.fortune, fortune);
  // 固定背景（bot-tan-fortune.png 1377px を半分に縮小）で合成されている。
  const decoded = await loadImage(image.data);
  assert.deepEqual([decoded.width, decoded.height], [688, 688]);
});
