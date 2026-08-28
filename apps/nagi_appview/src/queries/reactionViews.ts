import type {
  EmojiView,
  ReactionView,
} from "@bsky-affirmative-bot/nagi-lexicon";

export type ReactionViewRow = {
  subjectUri: string;
  emoji: string;
  emojiKey: string;
  emojiUri: string | null;
  subjectDid: string | null;
  did: string;
  uri: string;
  handle: string | null;
  displayName: string | null;
  avatarCid: string | null;
  bluemoji?: EmojiView;
};

/** indexedAt降順の行をsubject・絵文字ごとの表示形式へまとめる。 */
export function groupReactionViews(
  rows: ReactionViewRow[],
  viewerDid?: string,
): Map<string, ReactionView[]> {
  const grouped = new Map<string, Map<string, ReactionView>>();
  for (const row of rows) {
    // 規格外・削除済み Bluemoji の参照は無効リアクションとして扱う。
    if (row.emojiUri && !row.bluemoji) continue;
    let subject = grouped.get(row.subjectUri);
    if (!subject) {
      subject = new Map();
      grouped.set(row.subjectUri, subject);
    }
    let item = subject.get(row.emojiKey);
    if (!item) {
      item = {
        emoji: row.emoji,
        ...(row.bluemoji ? { bluemoji: row.bluemoji } : {}),
        reactors: [],
      };
      subject.set(row.emojiKey, item);
    }
    // 誰が誰へ頻繁に反応しているかを第三者が追跡できないよう、送信者の一覧は
    // リアクションを受け取った投稿者本人にだけ返す。ニュースなど投稿者を持たない
    // subject も匿名側に倒す。
    const canSeeReactors = Boolean(viewerDid && row.subjectDid === viewerDid);
    if (canSeeReactors) {
      if (item.reactors.length < 5) {
        item.reactors.push({
          did: row.did,
          handle: row.handle ?? row.did,
          displayName: row.displayName ?? undefined,
          avatar: row.avatarCid
            ? `/api/blob/${encodeURIComponent(row.did)}/${row.avatarCid}`
            : undefined,
        });
      } else {
        item.hasMoreReactors = true;
      }
    } else if (!viewerDid || row.did !== viewerDid) {
      // 人数は公開しない。自分が解除した後にも匿名の反応が残るかどうかだけを、
      // 楽観更新が絵文字グループを誤って消さないための既存フラグで保持する。
      item.hasMoreReactors = true;
    }
    if (viewerDid && row.did === viewerDid) {
      item.reactedByMe = true;
      item.viewerReactionUri = row.uri;
    }
  }
  return new Map(
    [...grouped].map(([subjectUri, reactions]) => [
      subjectUri,
      [...reactions.values()],
    ]),
  );
}
