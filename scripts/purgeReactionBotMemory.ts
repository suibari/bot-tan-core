import {
  client,
  purgeReactionBotMemory,
} from "@bsky-affirmative-bot/database";
import { pathToFileURL } from "node:url";

function printSummary(result: Awaited<ReturnType<typeof purgeReactionBotMemory>>) {
  for (const row of result.before) {
    console.log(`${row.sourceType}: documents=${row.documents}, usages=${row.usages}`);
  }
  console.log(result.applied
    ? `Deleted ${result.deleted} reaction memory documents.`
    : "Dry run only. Pass --apply to delete these documents.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  purgeReactionBotMemory(process.argv.includes("--apply"))
    .then(printSummary)
    .catch((error) => {
      console.error("[ERROR][BOT_MEMORY] Failed to purge reaction memories", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await client.end();
    });
}
