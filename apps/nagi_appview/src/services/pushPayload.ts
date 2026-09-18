/**
 * Web Push で端末へ送る payload の唯一の定義。
 *
 * ⚠ この型は nagi_client/src/service-worker.ts の PushPayload と対になっている。
 *    両者は別リポジトリなので型を共有できない。フィールドを足す・変える・消すときは
 *    必ず両方を更新すること。加えて受信側（SW）には常に「古いサーバーが送った payload」
 *    が届きうる前提でフォールバックを残す。SW の更新は端末に行き渡るまで時間がかかり、
 *    サーバーだけ先に進む状況が普通に起きる。
 *
 * ⚠ tag は「通知1件ごとに一意」でなければならない。
 *    Notifications 仕様では、同じ tag の通知がすでに表示されている状態で
 *    showNotification すると、既存の通知を静かに置き換えるだけで再アラートしない。
 *    音もバイブもバナーも出ないので、ユーザーからは「通知が来ない」ように見える。
 *    かつてここが種別名（reply/diary/...）だったため、2通目以降がすべて無音で
 *    潰れるという障害を起こした。tag には必ず通知レコードの id を含めること。
 *
 *    通知の同一性を決めるのはこの payload を作るサーバー側であって、SW ではない。
 *    SW に「何をもって同じ通知とみなすか」を判断させると、判断材料が足りないまま
 *    推測することになり、同じ事故が再発する。
 */

/** 通知種別。nagi.notifications.type と対応する。 */
export type PushNotificationType =
  "reply" | "reaction" | "mention" | "diary" | "analysis";

export interface PushPayload {
  title: string;
  body: string;
  type: PushNotificationType;
  /** 通知1件ごとに一意。理由は上のコメントを必ず読むこと。 */
  tag: string;
  /** 通知タップ時に開くパス。 */
  url: string;
}

/** 通知一覧ページ。今はすべての通知がここへ着地する。 */
const NOTIF_URL = "/notifications";

const CONTENT_WARNING_BODY = "Content Warning付き投稿";
const IMAGE_POST_BODY = "画像付きの投稿";
const QUOTE_POST_BODY = "引用付きの投稿";

/**
 * 投稿を端末通知へ安全に載せるための共通プレビュー。
 *
 * 本文は80文字に詰め、CW本文は露出しない。本文が空でも添付の種類だけは伝え、
 * 「何に対する通知か」が空欄にならないようにする。
 */
export function postPushBody(input: {
  text: unknown;
  contentWarning?: boolean;
  hasImages?: boolean;
  hasQuote?: boolean;
}): string {
  if (input.contentWarning) return CONTENT_WARNING_BODY;
  const text =
    typeof input.text === "string"
      ? input.text.replace(/\s+/g, " ").trim()
      : "";
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  if (input.hasImages) return IMAGE_POST_BODY;
  if (input.hasQuote) return QUOTE_POST_BODY;
  return "";
}

/**
 * payload を組み立てる唯一の入口。文面はサーバー側で作る（受信者の locale を
 * 持たないため日本語既定）。
 *
 * @param notificationId nagi.notifications.id（uuid）。tag の一意性の担保はこれだけ
 *   なので、呼び出し側で必ず実レコードの id を渡すこと。
 */
export function buildPushPayload(input: {
  type: PushNotificationType;
  notificationId: string;
  actorName: string;
  /** リアクション絵文字など、操作そのものを説明する短い文字列。 */
  actionText?: string;
  /** 新規内容。リアクションだけは対象投稿のプレビュー。 */
  contentText?: string;
}): PushPayload {
  const { type, notificationId, actorName, actionText, contentText } = input;
  return {
    ...compose(type, actorName, actionText, contentText),
    type,
    tag: `${type}-${notificationId}`,
    url: NOTIF_URL,
  };
}

function compose(
  type: PushNotificationType,
  name: string,
  actionText = "",
  contentText = "",
): { title: string; body: string } {
  switch (type) {
    case "reply":
      return { title: `${name}さんが返信しました`, body: contentText };
    case "mention":
      return {
        title: `${name}さんがあなたをメンションしました`,
        body: contentText,
      };
    case "reaction":
      return {
        title: actionText
          ? `${name}さんが${actionText}でリアクションしました`
          : `${name}さんがリアクションしました`,
        body: contentText,
      };
    case "diary":
      return { title: "botたんが日記を書きました", body: contentText };
    case "analysis":
      // 分析＝名刺の更新。actorName は常に botたんなので使わない。
      return { title: "botたんがあなたの名刺を更新しました", body: "" };
  }
}

/**
 * 全肯定カードまわり（ゼンカツの提出・ドローの控え）への通知本文。
 *
 * `postPushBody` は本文テキストを持つ投稿の形に固定されているが、ゼンカツは自由記述を
 * 持たない（カードでしか喋らない設計）ので、こちらで組み立てる。
 */
export function cardSubjectPushBody(
  subject:
    | { kind: "zenkatsu"; themeJa?: string; cardNames: string[] }
    | { kind: "cardGet"; cardNameJa: string },
): string {
  if (subject.kind === "cardGet") return `${subject.cardNameJa} をゲット`;
  const cards = subject.cardNames.join("・");
  return subject.themeJa ? `「${subject.themeJa}」に ${cards}` : cards;
}
