import assert from "node:assert/strict";
import test from "node:test";
import { formatFortuneText } from "../src/ai/generateFortuneResult.js";

const sections = {
  advice: "冒険と笑いが重なる日。",
  action: "青色の公園で空を見上げてみて。",
  luckies: [
    { label: "ラッキーフード", name: "麻婆カレー", reason: "辛さが元気をくれるから。" },
    { label: "ラッキーアニマル", name: "カワウソ", reason: "水辺で遊ぶ姿が楽しいから。" },
    { label: "ラッキースポット", name: "箱根", reason: "温泉でほっとできるから。" },
  ],
};

test("3つのラッキー項目は毎回、見出し付きで別の段落に分かれる", () => {
  const text = formatFortuneText(sections, "日本語");
  const blocks = text.split("\n\n");
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0], "【今日の運勢】\n冒険と笑いが重なる日。");
  assert.equal(blocks[1], "【ラッキーアクション】\n青色の公園で空を見上げてみて。");
  assert.equal(blocks[2], "【ラッキーフード】 麻婆カレー\n辛さが元気をくれるから。");
  assert.equal(blocks[3], "【ラッキーアニマル】 カワウソ\n水辺で遊ぶ姿が楽しいから。");
  assert.equal(blocks[4], "【ラッキースポット】 箱根\n温泉でほっとできるから。");
});

test("日本語以外は英語の見出しを使う", () => {
  const text = formatFortuneText(
    { ...sections, luckies: [{ label: "Lucky Food", name: "Curry", reason: "Spicy." }] },
    "English",
  );
  assert.match(text, /^\[Today's Fortune\]\n/);
  assert.match(text, /\n\n\[Lucky Action\]\n/);
  assert.match(text, /\n\n\[Lucky Food\] Curry\nSpicy\.$/);
  assert.doesNotMatch(text, /【/);
});

test("名称が取れなかった項目と空のセクションは出さない", () => {
  const text = formatFortuneText(
    { advice: "", action: "歩こう。", luckies: [{ label: "ラッキーフード", name: "", reason: "理由だけ" }] },
    "日本語",
  );
  assert.equal(text, "【ラッキーアクション】\n歩こう。");
});
