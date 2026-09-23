import assert from "node:assert/strict";
import test from "node:test";
import { selectNagiRadioPostContext } from "../src/ai/nagiRadioPostContext.js";

test("長い投稿期間でも全投稿を見て、印象的な1件と選曲文脈を返す", async () => {
  const posts = Array.from({ length: 12 }, (_, index) =>
    `post-${String(index).padStart(2, "0")}: ${"topic ".repeat(120)}`);
  const seen: string[] = [];
  const chat = async (_model: string, messages: { role: string; content: string }[]) => {
    const body = messages.at(-1)!.content;
    seen.push(body);
    const lines = body.split("\n");
    const lastMarker = [...body.matchAll(/post-\d{2}/g)].at(-1)?.[0] ?? "summary";
    return JSON.stringify({ summary: `Mood from ${lastMarker}`, index: lines.length });
  };
  const result = await selectNagiRadioPostContext(posts, "日本語", { chat });
  for (let index = 0; index < posts.length; index++)
    assert.ok(seen.some((body) => body.includes(`post-${String(index).padStart(2, "0")}`)));
  assert.equal(result.commentPostIndex, 11);
  assert.match(result.songContext, /Mood from post-/);
});

test("長文投稿の末尾も選曲用の要約へ渡す", async () => {
  const seen: string[] = [];
  const chat = async (_model: string, messages: { role: string; content: string }[]) => {
    seen.push(messages.at(-1)!.content);
    return JSON.stringify({ summary: "長文全体の話題", index: 999 });
  };
  const result = await selectNagiRadioPostContext(
    [`${"前半 ".repeat(1_000)}終盤に語った旅行の話`], "日本語", { chat });
  assert.ok(seen.some((body) => body.includes("終盤に語った旅行の話")));
  assert.equal(result.commentPostIndex, 0);
  assert.match(result.commentPostText, /終盤に語った旅行の話/);
  assert.match(result.songContext, /終盤に語った旅行の話/);
});
