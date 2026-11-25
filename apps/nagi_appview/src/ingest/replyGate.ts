import {
  db,
  nagiNotifications,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import { isReplyGate, replyGateAllows } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";

type DbLike = Pick<typeof db, "select" | "update" | "delete">;


/**
 * 返信先の replyGate がこの返信を受け付けるか。返信先がまだ取り込まれていない
 * （firehose の順序前後）ときは判定できないので受け付け、返信先の取り込み時に
 * hideGatedReplies が後から外す。
 */
export async function parentAcceptsReply(
  tx: DbLike,
  parentUri: string,
  replierDid: string,
  botDid: string,
): Promise<boolean> {
  const [parent] = await tx
    .select({ did: nagiPosts.did, recordJson: nagiPosts.recordJson })
    .from(nagiPosts)
    .where(and(eq(nagiPosts.uri, parentUri), isNull(nagiPosts.deletedAt)))
    .limit(1);
  if (!parent) return true;
  return replyGateAllows(
    (parent.recordJson as { replyGate?: unknown } | null)?.replyGate,
    parent.did,
    replierDid,
    botDid,
  );
}

/** 受け付けない返信を表示用データから外す。PDS のレコードは残るので行は論理削除にとどめる。 */
export async function hideReplies(tx: DbLike, uris: string[]): Promise<void> {
  if (!uris.length) return;
  await tx
    .update(nagiPosts)
    .set({ deletedAt: new Date() })
    .where(inArray(nagiPosts.uri, uris));
  await tx
    .delete(nagiNotifications)
    .where(
      or(
        inArray(nagiNotifications.reasonUri, uris),
        inArray(nagiNotifications.subjectUri, uris),
      ),
    );
}

/** 返信制限つきの投稿を取り込んだとき、先に届いていた受け付けない返信を外す。 */
export async function hideGatedReplies(
  tx: DbLike,
  parentUri: string,
  parentDid: string,
  gate: unknown,
  botDid: string,
): Promise<void> {
  if (!isReplyGate(gate)) return;
  const rows = await tx
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(
      and(
        eq(nagiPosts.replyParentUri, parentUri),
        isNull(nagiPosts.deletedAt),
        ne(nagiPosts.did, parentDid),
        ...(gate === "bot" ? [ne(nagiPosts.did, botDid)] : []),
      ),
    );
  await hideReplies(
    tx,
    rows.map((row) => row.uri),
  );
}
