import { AtpAgent } from "@atproto/api";
import { CONFIG, LABEL_DEFINITIONS } from "../src/config.js";

async function main() {
  console.log("============================================================");
  console.log("📝 Registering / Updating Labeler Service Definition");
  console.log("============================================================");
  console.log(`DID: ${CONFIG.did}`);

  if (!CONFIG.password) {
    console.error(
      "❌ LABELER_PASSWORD is required in .env to login and publish labeler records.",
    );
    process.exit(1);
  }

  const agent = new AtpAgent({ service: "https://bsky.social" });
  console.log("🔑 Logging in to Bluesky as Labeler account...");
  await agent.login({
    identifier: CONFIG.did,
    password: CONFIG.password,
  });
  console.log("✅ Logged in successfully.");

  const labelValues = LABEL_DEFINITIONS.map((def) => def.identifier);
  const labelValueDefinitions = LABEL_DEFINITIONS.map((def) => ({
    identifier: def.identifier,
    severity: def.severity,
    blurs: def.blurs,
    defaultSetting: def.defaultSetting,
    adultOnly: def.adultOnly ?? false,
    locales: def.locales,
  }));

  const record = {
    $type: "app.bsky.labeler.service",
    policies: {
      labelValues,
      labelValueDefinitions,
    },
    createdAt: new Date().toISOString(),
  };

  console.log(
    `📦 Publishing ${LABEL_DEFINITIONS.length} label definitions to app.bsky.labeler.service...`,
  );

  await agent.com.atproto.repo.putRecord({
    repo: CONFIG.did,
    collection: "app.bsky.labeler.service",
    rkey: "self",
    record,
  });

  console.log("🎉 Successfully published labeler service record!");
  console.log("Label definitions registered:");
  for (const def of LABEL_DEFINITIONS) {
    console.log(
      ` - ${def.identifier}: ${def.locales[0]?.name} (${def.locales[0]?.description})`,
    );
  }
}

main().catch((err) => {
  console.error("❌ Registration failed:", err);
  process.exit(1);
});
