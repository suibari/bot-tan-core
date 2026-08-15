import { AmaterasLabeler } from "./labeler.js";
import { CONFIG } from "./config.js";

async function main() {
  console.log("============================================================");
  console.log("☀️  Starting nagi_amateras (Lightweight Moderation & Labeler)");
  console.log("============================================================");
  console.log(`DID: ${CONFIG.did}`);
  console.log(`Port: ${CONFIG.port}`);
  console.log(`Database: ${CONFIG.dbPath}`);
  console.log(`OpenAI API: ${CONFIG.openaiApiKey ? "Configured" : "NOT SET"}`);
  console.log("------------------------------------------------------------");

  const labeler = new AmaterasLabeler();
  await labeler.start(CONFIG.port);
}

main().catch((err) => {
  console.error("❌ Fatal error in nagi_amateras:", err);
  process.exit(1);
});
