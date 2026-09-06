import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  buildAffirmativeInstructions,
  buildAffirmativeUserPost,
} from "../src/ai/generateAffirmativeWord.js";

const userinfo = (
  posts: string[],
  langStr: "日本語" | "English" = "日本語",
): UserInfoGemini =>
  ({
    follower: {
      did: "did:plc:test",
      handle: "test.example",
      displayName: "すいぱり",
    },
    posts,
    langStr,
  }) as UserInfoGemini;

/**
 * Gemma へ移して発現した2件の事故（行為者のすり替え・未完了を完了として祝う）を、
 * プロンプト側の対策が消えていないことで押さえる。返信そのものはモデル任せなので、
 * ここで固定できるのは「禁止が書かれていること」までになる。
 */
test("行為者のすり替えと未完了の祝いを名指しで禁止している", async () => {
  const prompt = await buildAffirmativeInstructions(
    userinfo(["子供のやってるポケモンのぞいたらコンパンにわるものって名前つけてて草"]),
  );

  assert.match(prompt, /## 投稿の読み取りについて/);
  assert.match(prompt, /行為をした人を、勝手に相手本人にしない/);
  assert.match(prompt, /まだ起きていないことを、起きたことにしない/);
  assert.match(prompt, /達成を祝う言葉を使ってはいけません/);
});

test("英語版にも同じ禁止がある", async () => {
  const prompt = await buildAffirmativeInstructions(
    userinfo(["Once I finish EO5-5 I need to write up my notes."], "English"),
  );

  assert.match(prompt, /## How to read the post/);
  assert.match(prompt, /Never reassign an action to the user/);
  assert.match(prompt, /Never treat something that has not happened as done/);
});

/**
 * botContext と grounding は contents[0]（＝指示側）の末尾へ積まれる。そのため
 * ユーザ投稿は別の要素として分かれていなければならない。指示側に投稿本文が
 * 混ざって戻ると、この分離が意味を失う。
 */
test("指示ブロックにユーザ投稿の本文が混ざっていない", async () => {
  const postText = "EO5-5終わらせたら、感想をまとめないとな";
  const info = userinfo([postText]);

  const instructions = await buildAffirmativeInstructions(info);
  const userPost = buildAffirmativeUserPost(info);

  assert.doesNotMatch(instructions, /## ユーザ投稿/);
  assert.ok(!instructions.includes(postText));
  assert.ok(userPost.includes(postText));
});

test("ユーザ投稿ブロックでは今回のポストが最後に来る", () => {
  const postText = "EO5-5終わらせたら、感想をまとめないとな";
  const userPost = buildAffirmativeUserPost(
    userinfo([postText, "きのうは艦これしてた", "BLEACH見た"]),
  );

  assert.ok(
    userPost.indexOf("### 今回のポスト") > userPost.indexOf("過去のポスト"),
    "今回のポストは過去のポストより後ろに置くこと",
  );
  assert.ok(userPost.indexOf(postText) > userPost.indexOf("きのうは艦これしてた"));
  assert.match(userPost, /返信するのは上の「今回のポスト」だけです/);
});

/**
 * `${posts.slice(1)}` のままだと Array.toString() でカンマ連結になり、投稿の境界が
 * 消える。Nagi 側はここへ「今回の投稿に意味的に近い過去投稿」を流すので、境界が
 * 無いと過去にやったことを今回やったことと取り違える。
 */
test("過去のポストが行で区切られ、カンマ連結になっていない", () => {
  const userPost = buildAffirmativeUserPost(
    userinfo(["いまのポスト", "過去A\n改行あり", "過去B"]),
  );

  assert.match(userPost, /^1\. 過去A 改行あり$/m);
  assert.match(userPost, /^2\. 過去B$/m);
  assert.doesNotMatch(userPost, /過去A[^\n]*,過去B/);
});

test("過去のポストが無ければ「なし」になる", () => {
  const userPost = buildAffirmativeUserPost(userinfo(["いまのポスト"]));
  assert.match(userPost, /過去のポスト（背景情報。直接言及しないこと）:\nなし/);
});
