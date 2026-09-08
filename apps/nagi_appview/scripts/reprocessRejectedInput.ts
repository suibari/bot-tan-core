import {
  db,
  nagiModerationDecisions,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq } from "drizzle-orm";
import { ensurePdsRecord } from "../src/ingest/reconcileRepo.js";
import { parseRecordUri } from "../src/ingest/recordUri.js";

const uri = process.argv[2];
if (!uri) throw new Error("Usage: reprocessRejectedInput <at://... post URI>");

const parsed = parseRecordUri(uri);
if (!parsed || parsed.collection !== NAGI.post)
  throw new Error("A com.suibari.nagi.post URI is required");

const [decision] = await db
  .select({
    decision: nagiModerationDecisions.decision,
    cid: nagiModerationDecisions.cid,
    ruleVersion: nagiModerationDecisions.ruleVersion,
  })
  .from(nagiModerationDecisions)
  .where(eq(nagiModerationDecisions.uri, uri))
  .limit(1);

if (!decision) throw new Error(`No moderation decision exists for ${uri}`);
if (decision.decision !== "reject-invalid")
  throw new Error(
    `Refusing to restore ${decision.decision}; this command only retries reject-invalid`,
  );

const ensured = await ensurePdsRecord(
  parsed.did,
  parsed.collection,
  parsed.rkey,
);
if (ensured.status !== "present")
  throw new Error(`The source record no longer exists in the PDS: ${uri}`);
if (ensured.record.cid !== decision.cid)
  throw new Error(
    `CID changed (${decision.cid} -> ${ensured.record.cid}); normal edit moderation will handle it`,
  );

await db
  .update(nagiPosts)
  .set({ moderationLabels: [], moderationVersion: null })
  .where(and(eq(nagiPosts.uri, uri), eq(nagiPosts.cid, ensured.record.cid)));

console.log(
  "[INFO][moderation] queued reject-invalid record for reprocessing",
  {
    uri,
    cid: ensured.record.cid,
    previousRuleVersion: decision.ruleVersion,
  },
);
