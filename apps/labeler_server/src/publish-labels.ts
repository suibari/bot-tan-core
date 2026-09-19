import { AtpAgent } from "@atproto/api";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { labelerServiceRecord } from "@bsky-affirmative-bot/shared-configs";
import { assertExternalAccountAccessAllowed } from "@bsky-affirmative-bot/shared-configs/externalAccountAccess";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  assertExternalAccountAccessAllowed("Labeler", "ALLOW_DEV_LABELER_WRITES", {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_DEV_LABELER_WRITES: process.env.ALLOW_DEV_LABELER_WRITES,
  });
  // 識別子はハンドルではなく DID。ハンドルは可変なので、変更のたびにログインが黙って壊れる。
  const identifier = process.env.LABELER_DID || process.env.BSKY_DID;
  const password = process.env.LABELER_PASSWORD || process.env.BSKY_APP_PASSWORD;

  if (!identifier || !password) {
    console.error(
      "[ERROR] Credentials not found. Please set BSKY_DID and BSKY_APP_PASSWORD (or LABELER_DID and LABELER_PASSWORD) in your .env file."
    );
    process.exit(1);
  }

  console.log(`[INFO] Authenticating as: ${identifier}`);
  const agent = new AtpAgent({ service: "https://bsky.social" });

  try {
    await agent.login({ identifier, password });
    console.log("[INFO] Authentication successful.");
  } catch (err: any) {
    console.error("[ERROR] Login failed:", err.response?.data || err.message || err);
    process.exit(1);
  }

  const repo = agent.session!.did;

  // 1. Read existing record
  let currentRecord: any = { policies: { labelValues: [], labelValueDefinitions: [] } };
  let cid: string | undefined;

  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo,
      collection: "app.bsky.labeler.service",
      rkey: "self",
    });
    currentRecord = res.data.value;
    cid = res.data.cid;
    const existingCount = currentRecord.policies?.labelValueDefinitions?.length ?? 0;
    console.log(`[INFO] Fetched existing record (${existingCount} definitions).`);
  } catch (e: any) {
    if (e.status !== 404 && !e.message?.includes("Could not locate record")) {
      throw e;
    }
    console.log("[INFO] No existing record found. Starting fresh.");
  }

  // 2. Merge static community badge defs into existing definitions
  const definitions: any[] = currentRecord.policies?.labelValueDefinitions ?? [];

  for (const staticDef of labelerServiceRecord.policies.labelValueDefinitions) {
    const idx = definitions.findIndex((d: any) => d.identifier === staticDef.identifier);
    if (idx >= 0) {
      definitions[idx] = staticDef;
      console.log(`[INFO] Updated existing definition: ${staticDef.identifier}`);
    } else {
      definitions.push(staticDef);
      console.log(`[INFO] Added new definition: ${staticDef.identifier}`);
    }
  }

  const labelValues = definitions.map((d: any) => d.identifier);
  console.log(`[INFO] Total definitions after merge: ${definitions.length}`);

  // 3. Write back with optimistic lock
  const updatedRecord = {
    $type: "app.bsky.labeler.service",
    policies: { labelValues, labelValueDefinitions: definitions },
    createdAt: new Date().toISOString(),
  };

  const putParams: any = {
    repo,
    collection: "app.bsky.labeler.service",
    rkey: "self",
    record: updatedRecord,
  };
  if (cid) {
    putParams.swapRecord = cid;
  }

  try {
    const res = await agent.com.atproto.repo.putRecord(putParams);
    console.log("[INFO] Successfully updated labeler definitions record.");
    console.log("[INFO] Record URI:", res.data.uri);
  } catch (error: any) {
    console.error(
      "[ERROR] Failed to update labeler definitions:",
      error.response?.data || error.message || error
    );
    process.exit(1);
  }
}

main();
