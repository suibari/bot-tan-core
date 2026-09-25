import { db, nagiChronicleReadYears } from "@bsky-affirmative-bot/database";
import type { ChronicleReadYear } from "@bsky-affirmative-bot/nagi-lexicon";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import { asc, eq, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { CHRONICLE_MIN_YEAR, getChronicle } from "./chronicle.js";

/** 総保存量は年数で決まる。入力の年範囲も実際に存在しうる期間に限定する。 */
export function parseChronicleReadYears(input: unknown): ChronicleReadYear[] {
  if (input === undefined) return [];
  const thisYear = Number(cardDrawDate().slice(0, 4));
  const invalid = () =>
    new ApiError(400, "invalid_request", "Invalid chronicleReadYears");
  if (!Array.isArray(input) || input.length > 100) throw invalid();
  const years = new Set<number>();
  return input.map((item) => {
    if (
      !item ||
      !Number.isInteger(item.year) ||
      item.year < CHRONICLE_MIN_YEAR ||
      item.year > thisYear ||
      typeof item.revision !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.revision) ||
      years.has(item.year)
    )
      throw invalid();
    years.add(item.year);
    return { year: item.year, revision: item.revision };
  });
}

export async function getChronicleReadYears(
  did: string,
): Promise<ChronicleReadYear[]> {
  return db
    .select({
      year: nagiChronicleReadYears.year,
      revision: nagiChronicleReadYears.revision,
    })
    .from(nagiChronicleReadYears)
    .where(eq(nagiChronicleReadYears.did, did))
    .orderBy(asc(nagiChronicleReadYears.year));
}

export async function putChronicleReadYears(
  did: string,
  years: ChronicleReadYear[],
) {
  if (!years.length) return;
  await db.transaction(async (tx) => {
    // 内容の検証と上書きを直列化する。古い画面の再送で新しい既読を戻さない。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"chronicle-read:" + did}))`,
    );
    for (const read of years) {
      const page = await getChronicle(
        {
          actor: did,
          viewerDid: did,
          cursor: String(read.year),
          lang: "ja",
          limit: 100,
        },
        tx,
      );
      // 未発行の値や内容変更前の版は保存しない。応答では現在の既読を返す。
      if (read.revision !== page.revision) continue;
      await tx
        .insert(nagiChronicleReadYears)
        .values({ did, ...read })
        .onConflictDoUpdate({
          target: [nagiChronicleReadYears.did, nagiChronicleReadYears.year],
          set: { revision: read.revision },
        });
    }
  });
}
