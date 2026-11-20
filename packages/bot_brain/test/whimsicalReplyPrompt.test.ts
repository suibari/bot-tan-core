import assert from "node:assert/strict";
import test from "node:test";
import { buildWhimsicalReplyPrompt } from "../src/ai/generateWhimsicalReply.js";

const userinfo = {
  follower: { did: "did:plc:user", handle: "user.example", displayName: "ゆーざー" },
  posts: ["近所のパン屋さんがお気に入りだよ"],
  langStr: "日本語",
} as any;

test("定期ポストの本文と紹介したニュースを渡し、ユーザーのリプライはいちばん後ろに置く", () => {
  const prompt = buildWhimsicalPlanless();
  assert.match(prompt, /あなたの定期ポスト/);
  assert.match(prompt, /みんなの近所にも、お気に入りのお店ある？/);
  assert.match(prompt, /紹介したニュースの見出し: 商店街に新しいパン屋/);
  assert.match(prompt, /問いかけで締めくくられているなら、ユーザーのリプライはその答え/);
  // 曲の欄（URL）は材料にしない。
  assert.doesNotMatch(prompt, /MyMoodSong|youtube\.com/);
  // ユーザーの投稿が最後（AGENTS.md「プロンプトの並び順」）。
  assert.ok(prompt.trimEnd().endsWith("近所のパン屋さんがお気に入りだよ"));
  assert.ok(prompt.indexOf("あなたの定期ポスト") < prompt.indexOf("ユーザーリプライ"));
});

test("定期ポストが読めないときは従来どおりリプライだけで書く", () => {
  const prompt = buildWhimsicalReplyPrompt(userinfo);
  assert.doesNotMatch(prompt, /あなたの定期ポスト/);
  assert.match(prompt, /ユーザーリプライ: 近所のパン屋さんがお気に入りだよ/);
});

function buildWhimsicalPlanless() {
  return buildWhimsicalReplyPrompt(userinfo, {
    text: "こんばんは！商店街に新しいパン屋さんができたんだって🥐\nみんなの近所にも、お気に入りのお店ある？\n\nMyMoodSong:\nSong - Artist\nhttps://www.youtube.com/watch?v=stub",
    linkTitle: "商店街に新しいパン屋",
  });
}
