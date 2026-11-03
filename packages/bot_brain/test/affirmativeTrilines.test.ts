import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  buildAffirmativeInstructions,
  buildAffirmativeUserPost,
} from "../src/ai/generateAffirmativeWord.js";

const lines = ["朝ごはんがおいしかった", "猫をなでた", "早く寝られた"];
const userinfo = (
  overrides: Partial<UserInfoGemini> = {},
  langStr: "日本語" | "English" = "日本語",
): UserInfoGemini =>
  ({
    follower: { did: "did:plc:test", handle: "test.example", displayName: "すいぱり" },
    posts: [lines.join("\n")],
    langStr,
    ...overrides,
  }) as UserInfoGemini;

test("3行日記なら、書いたこと自体と各行の両方を肯定させる", async () => {
  const prompt = await buildAffirmativeInstructions(userinfo({ trilinesDiary: lines }));

  assert.match(prompt, /## 今回のポストは「3行日記」です/);
  assert.match(prompt, /日記を書いたこと自体を全力で全肯定/);
  assert.match(prompt, /3つの行それぞれに、ひとことずつ具体的に触れて褒めて/);
  // 各行が短くても、短文向けの一言にはしない。
  assert.doesNotMatch(prompt, /50文字以内/);
  // 日記の指示より、読み取りとつらい話の扱いを優先する。
  assert.ok(prompt.indexOf("「3行日記」です") < prompt.indexOf("## 投稿の読み取りについて"));
});

test("英語版にも同じ指示がある", async () => {
  const prompt = await buildAffirmativeInstructions(
    userinfo({ trilinesDiary: ["Had a nice breakfast", "Pet a cat", "Slept early"] }, "English"),
  );
  assert.match(prompt, /## This post is a "3 Lines" diary/);
  assert.match(prompt, /affirm that they wrote the diary at all/);
  assert.match(prompt, /touch on each of the 3 lines/);
});

test("日記でなければ日記の指示を出さない", async () => {
  const prompt = await buildAffirmativeInstructions(userinfo());
  assert.doesNotMatch(prompt, /3行日記/);
});

test("ユーザ投稿では日記の行を1行ずつ並べ、日記であることを添える", () => {
  const userPost = buildAffirmativeUserPost(userinfo({ trilinesDiary: lines }));
  assert.match(userPost, /3行日記。今日のよかったことを1行ずつ書いたもの/);
  assert.match(userPost, /^- 猫をなでた$/m);
  assert.ok(userPost.trimEnd().indexOf("- 早く寝られた") > userPost.indexOf("### 今回のポスト"));
});
