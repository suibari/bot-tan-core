import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPushPayload,
  postPushBody,
  type PushNotificationType,
} from "../src/services/pushPayload.js";

test("buildPushPayload applies the notification presentation policy", () => {
  const cases: Array<{
    type: PushNotificationType;
    actionText?: string;
    contentText?: string;
    title: string;
    body: string;
  }> = [
    {
      type: "reply",
      contentText: "新しい返信です",
      title: "凪さんが返信しました",
      body: "新しい返信です",
    },
    {
      type: "mention",
      contentText: "@you お知らせです",
      title: "凪さんがあなたをメンションしました",
      body: "@you お知らせです",
    },
    {
      type: "reaction",
      actionText: "🌊",
      contentText: "リアクションされた投稿",
      title: "凪さんが🌊でリアクションしました",
      body: "リアクションされた投稿",
    },
    {
      type: "diary",
      contentText: "今日の日記",
      title: "botたんが日記を書きました",
      body: "今日の日記",
    },
    {
      type: "analysis",
      contentText: "端末通知には出さないタグライン",
      title: "botたんがあなたの名刺を更新しました",
      body: "",
    },
    {
      type: "gift",
      actionText: "三日坊主のリベンジャー",
      title: "あなたの『三日坊主のリベンジャー』が凪さんに届きました",
      body: "",
    },
  ];

  for (const [index, expected] of cases.entries()) {
    const payload = buildPushPayload({
      type: expected.type,
      notificationId: `notification-${index}`,
      actorName: "凪",
      actionText: expected.actionText,
      contentText: expected.contentText,
    });
    assert.equal(payload.title, expected.title);
    assert.equal(payload.body, expected.body);
    assert.equal(payload.tag, `${expected.type}-notification-${index}`);
    assert.equal(payload.url, "/notifications");
  }
});

test("reaction title supports Bluemoji aliases and a missing emoji fallback", () => {
  assert.equal(
    buildPushPayload({
      type: "reaction",
      notificationId: "bluemoji",
      actorName: "凪",
      actionText: ":nagi_wave:",
      contentText: "対象投稿",
    }).title,
    "凪さんが:nagi_wave:でリアクションしました",
  );
  assert.equal(
    buildPushPayload({
      type: "reaction",
      notificationId: "fallback",
      actorName: "凪",
    }).title,
    "凪さんがリアクションしました",
  );
});

test("notification tags remain unique for notifications of the same type", () => {
  const first = buildPushPayload({
    type: "reply",
    notificationId: "first",
    actorName: "凪",
  });
  const second = buildPushPayload({
    type: "reply",
    notificationId: "second",
    actorName: "凪",
  });
  assert.notEqual(first.tag, second.tag);
});

test("postPushBody hides CW text and describes attachment-only posts", () => {
  assert.equal(
    postPushBody({ text: "見せない本文", contentWarning: true }),
    "Content Warning付き投稿",
  );
  assert.equal(postPushBody({ text: "", hasImages: true }), "画像付きの投稿");
  assert.equal(postPushBody({ text: "", hasQuote: true }), "引用付きの投稿");
  assert.equal(postPushBody({ text: "" }), "");
});

test("postPushBody normalizes whitespace and truncates long text", () => {
  assert.equal(postPushBody({ text: "  波\n  の音  " }), "波 の音");
  const long = "波".repeat(81);
  assert.equal(postPushBody({ text: long }), `${"波".repeat(80)}…`);
});
