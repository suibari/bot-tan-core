/**
 * モデレーション通知まわりの純粋関数。discord.js に触れないのでそのままテストできる。
 */

/** ボタンの操作。今は解除だけ。BAN を足すときはここへ加える。 */
export type ModerationAction = "allow";

const PREFIX = "mod:";
/** Discord の custom_id の上限。 */
export const CUSTOM_ID_MAX = 100;

/** `mod:<action>:<uri>`。上限を超えるなら null（ボタンを付けない）。 */
export function moderationCustomId(
  action: ModerationAction,
  uri: string,
): string | null {
  const id = `${PREFIX}${action}:${uri}`;
  return id.length <= CUSTOM_ID_MAX ? id : null;
}

export function parseModerationCustomId(
  customId: string,
): { action: ModerationAction; uri: string } | null {
  if (!customId.startsWith(PREFIX)) return null;
  const rest = customId.slice(PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const action = rest.slice(0, separator);
  const uri = rest.slice(separator + 1);
  if (action !== "allow" || !uri.startsWith("at://")) return null;
  return { action, uri };
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
  status: "restored" | "unlabeled" | "absent" | "already" | "not-found";
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
    case "not-found":
      return `⚠️ 判定記録が見つかりません${who}。`;
  }
}
