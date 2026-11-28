import {
  db,
  nagiActors,
  nagiPrivateListMembers,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import type {
  ActorView,
  PrivateListView,
  SetPrivateListMemberResult,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import { assertAppviewWritable } from "../privateSpace/guard.js";

export const PRIVATE_LIST_LIMIT = 200 as const;

export function validatePrivateListTarget(
  ownerDid: string,
  memberDid: string,
  botDid: string,
) {
  if (!/^did:(plc|web):/.test(memberDid))
    throw new ApiError(400, "invalid_request", "memberDid must be a DID");
  if (memberDid === ownerDid)
    throw new ApiError(400, "invalid_request", "Cannot add yourself");
  if (memberDid === botDid)
    throw new ApiError(400, "invalid_request", "Bot-tan is already in Home");
}

export function assertPrivateListCapacity(count: number) {
  if (count >= PRIVATE_LIST_LIMIT)
    throw new ApiError(
      409,
      "private_list_limit",
      `Private list is limited to ${PRIVATE_LIST_LIMIT} members`,
    );
}

const actorView = (row: {
  memberDid: string;
  handle: string | null;
  displayName: string | null;
  avatarCid: string | null;
}): ActorView => ({
  did: row.memberDid,
  handle: row.handle ?? row.memberDid,
  ...(row.displayName ? { displayName: row.displayName } : {}),
  ...(row.avatarCid
    ? {
        avatar: `/api/blob/${encodeURIComponent(row.memberDid)}/${row.avatarCid}`,
      }
    : {}),
});

/** 本人の一覧を返す唯一の読み出し口。呼び出し側は必ず requiredServiceAuth を使うこと。 */
export async function getPrivateList(
  ownerDid: string,
): Promise<PrivateListView> {
  const rows = await db
    .select({
      memberDid: nagiPrivateListMembers.memberDid,
      handle: nagiActors.handle,
      displayName: nagiProfiles.displayName,
      avatarCid: nagiProfiles.avatarCid,
    })
    .from(nagiPrivateListMembers)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPrivateListMembers.memberDid))
    .leftJoin(
      nagiProfiles,
      eq(nagiProfiles.did, nagiPrivateListMembers.memberDid),
    )
    .where(eq(nagiPrivateListMembers.ownerDid, ownerDid))
    .orderBy(desc(nagiPrivateListMembers.createdAt));
  return { members: rows.map(actorView), limit: PRIVATE_LIST_LIMIT };
}

export async function loadPrivateListMemberDids(
  ownerDid: string,
): Promise<string[]> {
  const rows = await db
    .select({ memberDid: nagiPrivateListMembers.memberDid })
    .from(nagiPrivateListMembers)
    .where(eq(nagiPrivateListMembers.ownerDid, ownerDid));
  return rows.map((row) => row.memberDid);
}

/**
 * 追加・解除は所有者単位で直列化する。件数確認と insert の間に並行追加が入って
 * 200人を超えないよう、owner DID の hash を transaction advisory lock に使う。
 */
export async function setPrivateListMember(
  ownerDid: string,
  memberDid: string,
  included: boolean,
): Promise<SetPrivateListMemberResult> {
  validatePrivateListTarget(ownerDid, memberDid, config.botDid);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ownerDid}))`);
    await assertAppviewWritable(ownerDid, tx);
    if (!included) {
      await tx
        .delete(nagiPrivateListMembers)
        .where(
          and(
            eq(nagiPrivateListMembers.ownerDid, ownerDid),
            eq(nagiPrivateListMembers.memberDid, memberDid),
          ),
        );
      return { memberDid, included: false };
    }

    const existing = await tx
      .select({ memberDid: nagiPrivateListMembers.memberDid })
      .from(nagiPrivateListMembers)
      .where(
        and(
          eq(nagiPrivateListMembers.ownerDid, ownerDid),
          eq(nagiPrivateListMembers.memberDid, memberDid),
        ),
      )
      .limit(1);
    if (existing.length) return { memberDid, included: true };

    const actor = await tx
      .select({ did: nagiActors.did })
      .from(nagiActors)
      .where(
        and(eq(nagiActors.did, memberDid), eq(nagiActors.status, "active")),
      )
      .limit(1);
    if (!actor.length)
      throw new ApiError(404, "actor_not_found", "Nagi user not found");

    const [count] = await tx
      .select({
        value: sql<number>`count(*)::int`,
      })
      .from(nagiPrivateListMembers)
      .where(eq(nagiPrivateListMembers.ownerDid, ownerDid));
    assertPrivateListCapacity(count?.value ?? 0);

    await tx
      .insert(nagiPrivateListMembers)
      .values({ ownerDid, memberDid })
      .onConflictDoNothing();
    return { memberDid, included: true };
  });
}
