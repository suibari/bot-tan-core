import { randomUUID } from "node:crypto";
import {
  db,
  nagiNotifications,
  nagiReactionNoticeLedger,
} from "@bsky-affirmative-bot/database";
import { and, desc, eq, min } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 同じ相手・同じ対象へのリアクションを1件にまとめる長さ。最初の反応から数える。 */
export const REACTION_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ReactionNoticeDecision =
  /** 一度通知した絵文字の付け直し。元のグループへ、外す前の既読状態のまま戻すだけ。 */
  | { kind: "renotice"; groupId: string; notifiedAt: Date; readAt: Date | null }
  /** 5分以内の追加。同じグループへ未読で足すが、Push はしない。 */
  | { kind: "join"; groupId: string }
  /** 新しいグループ。Push するのはこれだけ。 */
  | { kind: "open" };

/**
 * 通知のしかたを決める。判定は2つだけ:
 * 1. 同じ相手・同じ対象への反応は、最初の反応から5分間を1件にまとめ、Push は最初の1回。
 * 2. 一度通知した絵文字は、外して付け直しても通知しない。
 *
 * 時刻は取り込んだ時刻で比べる。レコードの createdAt は送り手が自由に書けるので使わない。
 */
export function decideReactionNotice(
  notified:
    | { groupId: string; notifiedAt: Date; readAt: Date | null }
    | undefined,
  latestGroup: { groupId: string; startedAt: Date } | undefined,
  now: Date,
): ReactionNoticeDecision {
  if (notified) return { kind: "renotice", ...notified };
  if (
    latestGroup &&
    now.getTime() - latestGroup.startedAt.getTime() < REACTION_GROUP_WINDOW_MS
  )
    return { kind: "join", groupId: latestGroup.groupId };
  return { kind: "open" };
}

/**
 * リアクション通知の行を入れる。Push すべきときだけ通知 id を返す。
 *
 * 台帳（reaction_notice_ledger）はリアクションを外しても残す。通知行はリアクションと
 * 一緒に消えるので、台帳が無いと付け外しのたびに新しい通知と Push が飛ぶ。
 */
export async function insertReactionNotification(
  tx: Tx,
  input: {
    recipientDid: string;
    actorDid: string;
    subjectUri: string;
    reasonUri: string;
    emojiKey: string;
    now: Date;
  },
): Promise<{ pushNotificationId?: string }> {
  const { recipientDid, actorDid, subjectUri, reasonUri, emojiKey, now } =
    input;
  const pair = and(
    eq(nagiReactionNoticeLedger.recipientDid, recipientDid),
    eq(nagiReactionNoticeLedger.actorDid, actorDid),
    eq(nagiReactionNoticeLedger.subjectUri, subjectUri),
  );
  const [notified] = await tx
    .select({
      groupId: nagiReactionNoticeLedger.groupId,
      notifiedAt: nagiReactionNoticeLedger.notifiedAt,
      readAt: nagiReactionNoticeLedger.readAt,
    })
    .from(nagiReactionNoticeLedger)
    .where(and(pair, eq(nagiReactionNoticeLedger.emojiKey, emojiKey)))
    .limit(1);
  const startedAt = min(nagiReactionNoticeLedger.notifiedAt);
  const [latest] = notified
    ? []
    : await tx
        .select({ groupId: nagiReactionNoticeLedger.groupId, startedAt })
        .from(nagiReactionNoticeLedger)
        .where(pair)
        .groupBy(nagiReactionNoticeLedger.groupId)
        .orderBy(desc(startedAt))
        .limit(1);
  const decision = decideReactionNotice(
    notified,
    latest?.startedAt
      ? { groupId: latest.groupId, startedAt: latest.startedAt }
      : undefined,
    now,
  );
  // 付け直しは元の時刻・元の既読状態で戻す。一覧の並びも未読数も、外す前と変わらない。
  if (decision.kind === "renotice")
    return insertRow(
      decision.groupId,
      decision.notifiedAt,
      decision.readAt,
      false,
    );

  const groupId = decision.kind === "join" ? decision.groupId : randomUUID();
  const recorded = await tx
    .insert(nagiReactionNoticeLedger)
    .values({
      recipientDid,
      actorDid,
      subjectUri,
      emojiKey,
      groupId,
      notifiedAt: now,
    })
    .onConflictDoNothing()
    .returning({ groupId: nagiReactionNoticeLedger.groupId });
  if (recorded.length)
    return insertRow(groupId, now, null, decision.kind === "open");
  // 別の取り込みが先に台帳へ書いた。そちらが通知済みなので付け直し扱いにする。
  const [winner] = await tx
    .select({
      groupId: nagiReactionNoticeLedger.groupId,
      notifiedAt: nagiReactionNoticeLedger.notifiedAt,
      readAt: nagiReactionNoticeLedger.readAt,
    })
    .from(nagiReactionNoticeLedger)
    .where(and(pair, eq(nagiReactionNoticeLedger.emojiKey, emojiKey)))
    .limit(1);
  return winner
    ? insertRow(winner.groupId, winner.notifiedAt, winner.readAt, false)
    : {};

  async function insertRow(
    groupKey: string,
    createdAt: Date,
    readAt: Date | null,
    push: boolean,
  ) {
    const inserted = await tx
      .insert(nagiNotifications)
      .values({
        recipientDid,
        type: "reaction",
        actorDid,
        subjectUri,
        reasonUri,
        groupKey,
        createdAt,
        readAt,
      })
      .onConflictDoNothing()
      .returning({ id: nagiNotifications.id });
    return push && inserted[0] ? { pushNotificationId: inserted[0].id } : {};
  }
}
