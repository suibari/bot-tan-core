import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_ANALYSIS_BRIEF_EN,
  BOT_ANALYSIS_BRIEF_JA,
  type UserInfoGemini,
} from "@bsky-affirmative-bot/shared-configs";
import { buildAnalyzePrompt } from "../src/ai/generateAnalyzeResult.js";
import { buildNagiAnalysisPrompt } from "../src/ai/generateNagiAnalysis.js";

const input = {
  displayName: "まさ",
  posts: ["現場の仕事が終わった！", "きょうのごはんはカレー"],
  liked: ["まどマギの劇場版みてきた", "艦これのイベント走ってる"],
};

// 名刺が壊れた実例（2026-09-12）: リアクション先に出てくる作品名が、本人の趣味として
// 名刺のタグ（#アニメ好き #戦略ゲーム）と本文に載った。材料の切れ目と帰属を必ず示す。
test("リアクション先は他人の投稿として区別し、趣味の根拠にさせない", () => {
  const prompt = buildNagiAnalysisPrompt(input);

  assert.match(prompt, /## 本人がリアクションした、他の人の投稿/);
  assert.match(prompt, /本人の発言ではない/);
  assert.match(prompt, /本人のものとして書いては \*\*絶対にいけません\*\*/);
  assert.match(prompt, /趣味・好きなもの・仕事・していることは、\*\*本人の投稿に書かれているときだけ\*\*/);
  assert.match(prompt, /固有名詞（作品名・ゲーム名・製品名・技術名など）は、本人の投稿に出てきたものだけ/);
});

test("本人の投稿はプロンプトのいちばん後ろに置く", () => {
  const prompt = buildNagiAnalysisPrompt(input);

  const likedAt = prompt.indexOf("まどマギの劇場版みてきた");
  const ownAt = prompt.indexOf("現場の仕事が終わった！");
  assert.ok(likedAt > 0 && ownAt > 0);
  assert.ok(ownAt > likedAt, "本人の投稿がリアクション先より前に来ている");
  assert.match(prompt.slice(ownAt), /^[^#]*$/, "本人の投稿の後ろに別の節が続いている");
});

test("投稿は1件1行の箇条書きにして境界を残す", () => {
  const prompt = buildNagiAnalysisPrompt({
    ...input,
    posts: ["1行目\n2行目", "べつの投稿"],
  });

  assert.match(prompt, /- 1行目 2行目\n- べつの投稿/);
});

test("リアクションが無ければ節もルールも出さない（埋めるための穴を作らない）", () => {
  const prompt = buildNagiAnalysisPrompt({ ...input, liked: [] });

  assert.doesNotMatch(prompt, /リアクション/);
  assert.doesNotMatch(prompt, /相性の良さそうな人/);
  assert.match(prompt, /## 本人の投稿/);
});

// systemInstruction に botたん自身の趣味リストを載せると、それが分析対象の人の趣味として
// 出力に混ざる。分析用ブリーフには口調と拘束だけを置く。
test("分析用ブリーフに botたん自身の趣味を含めない", () => {
  assert.doesNotMatch(BOT_ANALYSIS_BRIEF_JA, /ストラテジー|ロボットアニメ|アニソン|サイクリング|モルフォ/);
  assert.match(BOT_ANALYSIS_BRIEF_JA, /あなた自身の趣味・好み・経験を、その人のものとして書いてはいけません/);
  assert.match(BOT_ANALYSIS_BRIEF_JA, /敬語/);
});

// --- Bluesky の「分析して」。Nagi と同じ事故が起きうるので同じ拘束を当てる ---

const userinfo = (
  langStr: "日本語" | "English",
  extra: Partial<UserInfoGemini> = {},
): UserInfoGemini => ({
  follower: { did: "did:plc:test", handle: "test.example", displayName: "まさ" },
  posts: ["現場の仕事が終わった！", "きょうのごはんはカレー"],
  likedByFollower: ["まどマギの劇場版みてきた", "艦これのイベント走ってる"],
  langStr,
  ...extra,
});

test("Bluesky 分析もいいね先を他人の投稿として区別する", () => {
  const prompt = buildAnalyzePrompt(userinfo("日本語"));

  assert.match(prompt, /## 本人がいいねした、他の人の投稿/);
  assert.match(prompt, /本人のものとして書いては \*\*絶対にいけません\*\*/);
  assert.match(prompt, /あなた自身（botたん）の趣味や好みを、本人の趣味として書いてはいけません/);
});

test("Bluesky 分析も本人の投稿を最後に置き、1件1行にする", () => {
  const prompt = buildAnalyzePrompt(userinfo("日本語"));

  const likedAt = prompt.indexOf("まどマギの劇場版みてきた");
  const ownAt = prompt.indexOf("- 現場の仕事が終わった！");
  assert.ok(likedAt > 0 && ownAt > 0);
  assert.ok(ownAt > likedAt, "本人の投稿がいいね先より前に来ている");
  assert.match(prompt, /- 現場の仕事が終わった！\n- きょうのごはんはカレー/);
});

test("Bluesky 分析は英語でも同じ拘束をかける", () => {
  const prompt = buildAnalyzePrompt(userinfo("English"));

  assert.match(prompt, /## Posts by OTHER PEOPLE that they liked/);
  assert.match(prompt, /written by other people/);
  assert.match(prompt, /Never present your own hobbies or tastes as theirs/);
  const likedAt = prompt.indexOf("まどマギの劇場版みてきた");
  const ownAt = prompt.indexOf("- 現場の仕事が終わった！");
  assert.ok(ownAt > likedAt, "本人の投稿がいいね先より前に来ている");
});

test("いいねが無ければ Bluesky 分析でもいいねの節を出さない", () => {
  const prompt = buildAnalyzePrompt(userinfo("日本語", { likedByFollower: [] }));

  assert.doesNotMatch(prompt, /いいね/);
  assert.doesNotMatch(prompt, /相性の良さそうな人/);
});

test("英語版ブリーフにも botたん自身の趣味を含めない", () => {
  assert.doesNotMatch(BOT_ANALYSIS_BRIEF_EN, /strategy|anime|Morpho|cycling/i);
  assert.match(BOT_ANALYSIS_BRIEF_EN, /Never attribute your own hobbies/);
});

// --- 材料の分量。他人の文章が本人の何倍も積まれると、量でも引っ張られる ---

test("リアクション先は件数と長さを絞る（本人の投稿は絞らない）", () => {
  const long = "あ".repeat(500);
  const prompt = buildNagiAnalysisPrompt({
    displayName: "まさ",
    posts: [long],
    liked: Array.from({ length: 50 }, (_, index) => `${index}:${long}`),
  });

  // 本人の投稿は全文が残る。
  assert.ok(prompt.includes(`- ${long}`));
  // リアクション先は30件まで。
  assert.ok(prompt.includes("- 29:"));
  assert.ok(!prompt.includes("- 30:"));
  // 1件200字で打ち切る（末尾に … が付く）。
  assert.match(prompt, /- 0:あ{198}…/);
});
