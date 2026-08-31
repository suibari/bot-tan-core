import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const {
  canStockForAuthor,
  communityAffirmationGenerationWindow,
  communityAffirmationRetry,
  hasCommunityAffirmationContentWarning,
  isNewCommunityAffirmationCandidateReactionEligible,
} = await import("../src/NagiCommunityAffirmationWorker.js");
const { buildCommunityAffirmationPrompt, parseCommunityAffirmationResponse } =
  await import("@bsky-affirmative-bot/bot-brain");

test("匿名要約は投稿を移動させる比喩ではなく内容への反応を求める", () => {
  const prompt = buildCommunityAffirmationPrompt({
    text: "散歩で約2000歩を目指している",
  });
  assert.match(prompt, /投稿の具体的な内容に対する反応を書く/);
  assert.match(prompt, /ひと続きの完成文/);
  assert.match(
    prompt,
    /同じ事実を繰り返したり、言い換えてもう一度紹介したりしない/,
  );
  assert.match(prompt, /投稿内容を要約すると/);
  assert.match(prompt, /根拠が少なければ短く書く/);
  assert.match(prompt, /匿名の第三者形/);
  assert.match(prompt, /望ましい構成例/);
  assert.match(prompt, /一人称として引き受けない/);
  assert.doesNotMatch(prompt, /連れてき/);
});

test("1作者のストックは直近24時間で3件まで", () => {
  // 主キーが投稿になったので「1作者1行」という構造上の制約は無い。
  // 占有防止はこの本数だけで担保する。
  assert.equal(canStockForAuthor(0), true);
  assert.equal(canStockForAuthor(2), true);
  assert.equal(canStockForAuthor(3), false);
  assert.equal(canStockForAuthor(10), false);
});

test("プロンプト更新では表示期間内のカードだけを再生成対象にする", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  assert.deepEqual(communityAffirmationGenerationWindow(now), {
    newest: new Date("2026-08-31T23:00:00.000Z"),
    oldest: new Date("2026-08-25T00:00:00.000Z"),
  });
});

test("リアクション上限は新規候補の選定だけに適用する", () => {
  assert.equal(isNewCommunityAffirmationCandidateReactionEligible(1), true);
  assert.equal(isNewCommunityAffirmationCandidateReactionEligible(2), false);
});

test("一時障害は指数バックオフし、5回目で打ち切る", () => {
  assert.deepEqual(communityAffirmationRetry(1), {
    failed: false,
    backoffMs: 10_000,
  });
  assert.deepEqual(communityAffirmationRetry(4), {
    failed: false,
    backoffMs: 80_000,
  });
  assert.deepEqual(communityAffirmationRetry(5), {
    failed: true,
    backoffMs: 160_000,
  });
  assert.deepEqual(communityAffirmationRetry(10), {
    failed: true,
    backoffMs: 300_000,
  });
});

test("本文・レコード・画像のいずれかにCWがあれば除外する", () => {
  assert.equal(
    hasCommunityAffirmationContentWarning({
      text: "前 ||伏せる内容|| 後",
      recordJson: {},
      embedImages: [],
    }),
    true,
  );
  assert.equal(
    hasCommunityAffirmationContentWarning({
      text: "通常文",
      recordJson: { cwRestricted: true },
      embedImages: [],
    }),
    true,
  );
  assert.equal(
    hasCommunityAffirmationContentWarning({
      text: "通常文",
      recordJson: {},
      embedImages: [{ contentWarning: true }],
    }),
    true,
  );
  assert.equal(
    hasCommunityAffirmationContentWarning({
      text: "通常文",
      recordJson: {},
      embedImages: [],
    }),
    false,
  );
});

test("構造化要約は完成文をそのまま使い、日英の空・文字数だけを検査する", () => {
  const accepted = parseCommunityAffirmationResponse(
    JSON.stringify({
      publishable: true,
      summaryJa:
        "難所を工夫で突破したという投稿を見つけたよ！予想外の発想がかっこよすぎる〜！わたしまで元気をもらったよ！",
      summaryEn:
        "Someone found a creative way through a challenge! That unexpected idea is so cool! It gave me a burst of energy too!",
      reasonCode: "",
    }),
  );
  assert.equal(accepted.publishable, true);
  assert.equal(
    accepted.summaryJa,
    "難所を工夫で突破したという投稿を見つけたよ！予想外の発想がかっこよすぎる〜！わたしまで元気をもらったよ！",
  );

  const contentIsNotRevalidated = parseCommunityAffirmationResponse(
    JSON.stringify({
      publishable: true,
      summaryJa:
        "あなたにおめでとうを届けたいポストだよ。その成果を全肯定したくなったよ。",
      summaryEn:
        "A post worth celebrating. Congratulations on the achievement.",
      reasonCode: "",
    }),
  );
  assert.equal(contentIsNotRevalidated.publishable, true);

  const legacyShape = parseCommunityAffirmationResponse(
    JSON.stringify({
      publishable: true,
      postSummaryJa: "こんな投稿を見つけたよ！",
      botCommentJa: "古い分割形式のコメントだよ。",
      postSummaryEn: "I found a post!",
      botCommentEn: "This is a legacy split response.",
      reasonCode: "",
    }),
  );
  assert.equal(legacyShape.publishable, false);
  assert.equal(legacyShape.reasonCode, "invalid_length");

  const modelRejected = parseCommunityAffirmationResponse(
    JSON.stringify({
      publishable: false,
      summaryJa: "",
      summaryEn: "",
      reasonCode: "",
    }),
  );
  assert.equal(modelRejected.publishable, false);
  assert.equal(modelRejected.reasonCode, "model_rejected");

  const tooLong = parseCommunityAffirmationResponse(
    JSON.stringify({
      publishable: true,
      summaryJa: "短い紹介とコメントだよ。",
      summaryEn: "x".repeat(321),
      reasonCode: "",
    }),
  );
  assert.equal(tooLong.publishable, false);
  assert.equal(tooLong.reasonCode, "invalid_length");
});
