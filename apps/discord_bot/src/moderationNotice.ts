/**
 * モデレーション通知まわりの純粋関数。discord.js に触れないのでそのままテストできる。
 */

/** ボタンの操作。今は解除だけ。BAN を足すときはここへ加える。 */
export type ModerationAction = "allow";

const PREFIX = "mod:";

/**
 * ボタンの custom_id は `mod:<action>` だけにする。
 *
 * 対象の URI と cid は合わせて約140文字になり、custom_id の上限（100文字）に入らない。
 * そこで bot 自身が投稿した通知の embed フッターに書いておき、押されたらそこから読む
 * （bot の投稿は他人が編集できない）。
 */
export function moderationCustomId(action: ModerationAction): string {
  return `${PREFIX}${action}`;
}

export function parseModerationCustomId(
  customId: string,
): { action: ModerationAction } | null {
  return customId === `${PREFIX}allow` ? { action: "allow" } : null;
}

const SUBJECT_PREFIX = "subject: ";

/** 通知の embed フッター。判定した内容（uri と cid）をボタンに結び付ける。 */
export function noticeFooter(uri: string, cid: string): string {
  return `${SUBJECT_PREFIX}${uri} ${cid}`;
}

export function parseNoticeSubject(
  footer: string | null | undefined,
): { uri: string; cid: string } | null {
  if (!footer?.startsWith(SUBJECT_PREFIX)) return null;
  const match = /^(at:\/\/\S+) ([A-Za-z0-9]+)$/.exec(
    footer.slice(SUBJECT_PREFIX.length),
  );
  return match ? { uri: match[1], cid: match[2] } : null;
}

/**
 * 解除を押せるか。専用ロールがあればそれを、無ければサーバー管理権限を見る。
 * 通知チャンネルが見えるだけの購読者に押させないため、どちらも無ければ拒否する。
 */
export function canModerate(
  member: { roleIds: Iterable<string>; manageGuild: boolean },
  moderatorRoleId: string | undefined,
): boolean {
  if (member.manageGuild) return true;
  if (!moderatorRoleId) return false;
  for (const id of member.roleIds) if (id === moderatorRoleId) return true;
  return false;
}

export type OverrideResponse = {
  status:
    | "restored"
    | "unlabeled"
    | "absent"
    | "already"
    | "stale"
    | "not-found";
  cidChanged?: boolean;
};

/** 押した結果をメッセージに追記する1行。 */
export function overrideResultLine(
  result: OverrideResponse,
  actor: string,
): string {
  const who = `（${actor}）`;
  switch (result.status) {
    case "restored":
      return result.cidChanged
        ? `✅ 解除しました${who}。ただし判定後に編集されているため、新しい内容は改めて判定されます。`
        : `✅ 解除しました${who}。表示を戻しました（翻訳・通知・botたんの返信は戻りません）。`;
    case "unlabeled":
      return `✅ 解除しました${who}。ラベルを外しました。`;
    case "absent":
      return `⚠️ 解除を記録しました${who}が、元の投稿は既に削除されています。`;
    case "already":
      return `ℹ️ 既に解除済みです${who}。`;
    case "stale":
      return `⚠️ この通知の後で内容が変わり、新しい判定が出ています${who}。新しい通知を確認してください。`;
    case "not-found":
      return `⚠️ 判定記録が見つかりません${who}。`;
  }
}
