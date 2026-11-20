/**
 * 気まぐれポストの試し書き（`pnpm whimsical:news:preview`）。
 * 本番と同じ規則で Nagi のニュースを1件選び、本文だけを生成して表示する。
 * 投稿・紹介済み履歴の更新はしない。
 */
import { WhimsicalPostGenerator } from "@bsky-affirmative-bot/bot-brain";
import { nagiNewsPageUrl } from "@bsky-affirmative-bot/database";
import { pickWhimsicalNagiNews } from "./ScheduledPostCoordinator.js";

async function main() {
  const news = await pickWhimsicalNagiNews();
  console.log("\n=== Nagi news ===");
  if (news) {
    console.log(`articleId: ${news.articleId}`);
    console.log(`title: ${news.titleJa}`);
    console.log(`comment: ${news.commentJa}`);
    console.log(`card: ${nagiNewsPageUrl(news.rkey)} (thumb: ${news.imageUrl ?? "none"})`);
  } else {
    console.log("(none)");
  }

  const generator = new WhimsicalPostGenerator();
  for (const langStr of ["日本語", "English"] as const) {
    const generated = await generator.generate({
      langStr,
      currentMood: "ニュースを眺めながら、のんびり過ごしているよ",
      focus: "mood",
      nagiNews: news
        ? { titleJa: news.titleJa, commentJa: news.commentJa, titleEn: news.titleEn, commentEn: news.commentEn }
        : undefined,
    });
    console.log(`\n=== Generated post (${langStr}) ===`);
    console.log(langStr === "日本語" ? generated.textJa : generated.textEn);
  }
  console.log("\nNOTE: 通常の定期投稿では、この本文の後ろにMyMoodSongが追加されます。投稿・利用履歴更新は行っていません。");
}

main()
  .catch((error) => {
    console.error("[ERROR][WHIMSICAL_PREVIEW]", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
