/**
 * 返信先本人への通知を作るか。
 *
 * silentReply は返信通知だけを抑止する。本文中で別の相手を明示的に mention した場合の
 * 通知や、後から付くリアクションの通知まで黙らせないため、それらの判定とは分ける。
 */
export function shouldNotifyReply(record: {
  silentReply?: unknown;
  reply?: { parent?: { uri?: unknown } };
}): boolean {
  return (
    typeof record.reply?.parent?.uri === "string" && record.silentReply !== true
  );
}

/** 返信通知と mention 通知が同じ相手へ重複・迂回しないよう、mention の宛先を絞る。 */
export function mentionNotificationRecipients(
  mentionedDids: string[],
  authorDid: string,
  replyRecipientDid?: string,
): string[] {
  return mentionedDids.filter(
    (recipientDid) =>
      recipientDid !== authorDid && recipientDid !== replyRecipientDid,
  );
}
