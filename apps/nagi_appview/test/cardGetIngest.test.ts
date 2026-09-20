import assert from "node:assert/strict";
import test from "node:test";
import { NAGI, NAGI_INGEST_COLLECTIONS } from "@bsky-affirmative-bot/nagi-lexicon";
import { isReconcilableCollection } from "../src/ingest/reconcileRepo.js";

test("cardGet is accepted by immediate, Jetstream, and repo reconciliation paths", () => {
  assert.equal(isReconcilableCollection("did:plc:card-owner", NAGI.cardGet), true);
  assert.ok(NAGI_INGEST_COLLECTIONS.includes(NAGI.cardGet));
  assert.equal(isReconcilableCollection("did:plc:card-owner", NAGI.appLinks), false);
});
