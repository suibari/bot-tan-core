import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { db, nagiUnicodeEmojis } from "@bsky-affirmative-bot/database";
import { ne, sql } from "drizzle-orm";
import { normalizeEmojiText } from "./emojiSearchText.js";

/**
 * Unicode 絵文字の検索表を emoji-picker-element-data から同期する。
 * クライアントのピッカーと同じデータを使うので、出せる絵文字の集合が揃う。
 *
 * 埋め込みは EmbeddingWorker が embedding IS NULL を拾って作る。
 * 埋め込み文が変わらない行は embedding を保つので、データ版を上げても
 * 作り直すのは変わった行だけ。
 */

type RawEmoji = {
  emoji: string;
  annotation: string;
  tags?: string[];
  shortcodes?: string[];
  order?: number;
};

/** 行の組み立て方を変えたら上げる。データ版と合わせて同期の要否を決める。 */
const FORMAT_VERSION = 1;

export type UnicodeEmojiRow = typeof nagiUnicodeEmojis.$inferInsert;

export function buildUnicodeEmojiRows(
  ja: RawEmoji[],
  en: RawEmoji[],
  dataVersion: string,
): UnicodeEmojiRow[] {
  const enByEmoji = new Map(en.map((entry) => [entry.emoji, entry]));
  return ja.map((jaEntry) => {
    const enEntry = enByEmoji.get(jaEntry.emoji);
    const labelEn = enEntry?.annotation ?? jaEntry.annotation;
    const unique = (values: (string | undefined)[]) => [
      ...new Set(values.map((value) => normalizeEmojiText(value ?? "")).filter(Boolean)),
    ];
    const tagsJa = jaEntry.tags ?? [];
    const tagsEn = enEntry?.tags ?? [];
    return {
      emoji: jaEntry.emoji,
      labelJa: jaEntry.annotation,
      labelEn,
      labels: unique([jaEntry.annotation, labelEn]).join("\n"),
      keywords: unique([
        jaEntry.annotation,
        labelEn,
        ...(jaEntry.shortcodes ?? []),
        ...(enEntry?.shortcodes ?? []),
        ...tagsJa,
        ...tagsEn,
      ]).join("\n"),
      sortOrder: jaEntry.order ?? 0,
      // ショートコード（fire, flame など）は英語タグと重なるうえ記号混じりなので入れない。
      embedText: [
        `${jaEntry.annotation} / ${labelEn}`,
        tagsJa.join("、"),
        tagsEn.join(", "),
      ]
        .filter(Boolean)
        .join("\n"),
      dataVersion,
    };
  });
}

async function loadData(): Promise<{ rows: UnicodeEmojiRow[]; dataVersion: string }> {
  const require = createRequire(import.meta.url);
  const read = async (path: string) =>
    JSON.parse(await readFile(require.resolve(path), "utf8"));
  const [ja, en, pkg] = await Promise.all([
    read("emoji-picker-element-data/ja/emojibase/data.json") as Promise<RawEmoji[]>,
    read("emoji-picker-element-data/en/emojibase/data.json") as Promise<RawEmoji[]>,
    read("emoji-picker-element-data/package.json") as Promise<{ version: string }>,
  ]);
  const dataVersion = `${pkg.version}+${FORMAT_VERSION}`;
  return { rows: buildUnicodeEmojiRows(ja, en, dataVersion), dataVersion };
}

const UPSERT_CHUNK = 200;

/** 起動時に1回呼ぶ。全行が現在の版なら何もしない。 */
export async function syncUnicodeEmojis(): Promise<void> {
  const { rows, dataVersion } = await loadData();
  const [{ total, stale }] = await db
    .select({
      total: sql<number>`count(*)::int`,
      stale: sql<number>`count(*) filter (where ${nagiUnicodeEmojis.dataVersion} <> ${dataVersion})::int`,
    })
    .from(nagiUnicodeEmojis);
  if (total === rows.length && stale === 0) return;

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await db
      .insert(nagiUnicodeEmojis)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: nagiUnicodeEmojis.emoji,
        set: {
          labelJa: sql`excluded.label_ja`,
          labelEn: sql`excluded.label_en`,
          labels: sql`excluded.labels`,
          keywords: sql`excluded.keywords`,
          sortOrder: sql`excluded.sort_order`,
          embedText: sql`excluded.embed_text`,
          dataVersion: sql`excluded.data_version`,
          embedding: sql`case when ${nagiUnicodeEmojis.embedText} is distinct from excluded.embed_text then null else ${nagiUnicodeEmojis.embedding} end`,
        },
      });
  }
  // データから消えた絵文字（版の更新で外れたもの）は検索に出さない。
  await db.delete(nagiUnicodeEmojis).where(ne(nagiUnicodeEmojis.dataVersion, dataVersion));
  console.info(`[unicodeEmojiIndex] synced ${rows.length} emojis (${dataVersion})`);
}
