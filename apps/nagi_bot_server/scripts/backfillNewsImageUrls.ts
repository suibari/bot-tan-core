/**
 * 一覧に残っている承認済みニュースへ、OGP画像のURL文字列だけを後から補う。
 * 画像本体のダウンロード・保存はしない。
 *
 * Preview:
 *   pnpm --filter nagi-bot-server news:image:backfill
 * Apply:
 *   pnpm --filter nagi-bot-server news:image:backfill --apply
 */
import {
  db,
  nagiNews,
  nagiNewsApprovals,
} from "@bsky-affirmative-bot/database";
import { getNewsMetadata } from "@bsky-affirmative-bot/nagi-linkcard";
import { and, desc, eq, gte, isNull } from "drizzle-orm";

const apply = process.argv.slice(2).filter((arg) => arg !== "--").includes("--apply");
const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
const rows = await db
  .select({
    uri: nagiNewsApprovals.newsUri,
    cid: nagiNewsApprovals.newsCid,
    url: nagiNewsApprovals.snapshotUrl,
    fallbackUrl: nagiNews.url,
    title: nagiNewsApprovals.snapshotTitleJa,
  })
  .from(nagiNewsApprovals)
  .innerJoin(
    nagiNews,
    and(
      eq(nagiNews.uri, nagiNewsApprovals.newsUri),
      eq(nagiNews.cid, nagiNewsApprovals.newsCid),
    ),
  )
  .where(
    and(
      eq(nagiNewsApprovals.status, "approved"),
      isNull(nagiNewsApprovals.hiddenAt),
      isNull(nagiNewsApprovals.snapshotImageUrl),
      isNull(nagiNews.deletedAt),
      gte(nagiNews.indexedAt, since),
    ),
  )
  .orderBy(desc(nagiNews.indexedAt));

console.log(`[NEWS_IMAGE_BACKFILL] targets=${rows.length} apply=${apply}`);
if (!apply) {
  for (const row of rows.slice(0, 10))
    console.log(`- ${row.title ?? row.uri} (${row.url ?? row.fallbackUrl})`);
  process.exit(0);
}

let updated = 0;
let withoutImage = 0;
let failed = 0;
for (const row of rows) {
  try {
    const metadata = await getNewsMetadata(row.url ?? row.fallbackUrl);
    const image = httpsUrl(metadata.image);
    if (!image) {
      withoutImage++;
      continue;
    }
    await db
      .update(nagiNewsApprovals)
      .set({ snapshotImageUrl: image })
      .where(
        and(
          eq(nagiNewsApprovals.newsUri, row.uri),
          eq(nagiNewsApprovals.newsCid, row.cid),
        ),
      );
    updated++;
  } catch (error) {
    failed++;
    console.warn(
      `[WARN][NEWS_IMAGE_BACKFILL] ${row.uri}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

console.log(
  `[NEWS_IMAGE_BACKFILL] updated=${updated} withoutImage=${withoutImage} failed=${failed}`,
);
process.exit(failed ? 1 : 0);

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
