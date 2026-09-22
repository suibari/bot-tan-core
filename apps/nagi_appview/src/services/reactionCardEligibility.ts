import {
  NAGI,
  STANDARD_SITE_DOCUMENT,
  type NagiReaction,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import { validateRecord } from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";
import { DID, resolvePdsUrl } from "../util/pds.js";

type RepoRecord = { uri?: unknown; cid?: unknown; value?: unknown };

/** PDSから得たレコードが、当日のリアクション枠を解放できるかを副作用なしで検証する。 */
export function isEligibleReactionCardTrigger(
  viewerDid: string,
  reactionUri: string,
  record: unknown,
  now: Date = new Date(),
): record is NagiReaction {
  const [, , ownerDid, collection, rkey] = reactionUri.split("/");
  if (
    ownerDid !== viewerDid ||
    collection !== NAGI.reaction ||
    !rkey ||
    !validateRecord(NAGI.reaction, record)
  )
    return false;

  const reaction = record as NagiReaction;
  const subjectParts = reaction.subject.uri.split("/");
  const subjectDid = subjectParts[2];
  const subjectCollection = subjectParts[3];
  return (
    !!subjectDid &&
    DID.test(subjectDid) &&
    subjectDid !== viewerDid &&
    (subjectCollection === NAGI.post ||
      subjectCollection === STANDARD_SITE_DOCUMENT ||
      subjectCollection === NAGI.news) &&
    cardDrawDate(new Date(reaction.createdAt)) === cardDrawDate(now)
  );
}

/** Jetstreamの到着を待たず、書き込み先PDSを真実源としてリアクションを確認する。 */
export async function verifyReactionCardTrigger(
  viewerDid: string,
  reactionUri: string,
  now: Date = new Date(),
): Promise<void> {
  const [, , ownerDid, collection, rkey] = reactionUri.split("/");
  if (ownerDid !== viewerDid || collection !== NAGI.reaction || !rkey)
    throw new ApiError(400, "invalid_request", "Invalid reactionUri");

  const pds = await resolvePdsUrl(viewerDid);
  pds.pathname = "/xrpc/com.atproto.repo.getRecord";
  pds.search = new URLSearchParams({
    repo: viewerDid,
    collection: NAGI.reaction,
    rkey,
  }).toString();
  const response = await fetch(pds, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new ApiError(400, "invalid_request", "Reaction record not found");
  const body = (await response.json()) as RepoRecord;
  if (
    body.uri !== reactionUri ||
    !isEligibleReactionCardTrigger(viewerDid, reactionUri, body.value, now)
  )
    throw new ApiError(400, "invalid_request", "Reaction is not eligible");
}
