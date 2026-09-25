import { db, nagiChronicleReadRevisions } from "@bsky-affirmative-bot/database";
import { eq } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

/** 既読は追記のみ。古い端末からの保存でも他端末の既読を消さない。 */
export function parseChronicleReadRevisions(input: unknown): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 200 ||
    input.some(
      (value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value),
    )
  )
    throw new ApiError(
      400,
      "invalid_request",
      "Invalid chronicleReadRevisions",
    );
  return [...new Set(input as string[])];
}

/** did は必ず認証済みのviewerDidを渡す。本文やクエリのDIDは使わない。 */
export async function getChronicleReadRevisions(
  did: string,
): Promise<string[]> {
  const rows = await db
    .select({ revision: nagiChronicleReadRevisions.revision })
    .from(nagiChronicleReadRevisions)
    .where(eq(nagiChronicleReadRevisions.did, did));
  return rows.map((row) => row.revision);
}

export async function addChronicleReadRevisions(
  did: string,
  revisions: string[],
) {
  if (!revisions.length) return;
  await db
    .insert(nagiChronicleReadRevisions)
    .values(revisions.map((revision) => ({ did, revision })))
    .onConflictDoNothing();
}
