import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
dotenv.config({ path: path.resolve(envPath) });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  const result = await sql.begin(async (tx) => {
    // デプロイをロック待ちのまま停滞させない。失敗時はトランザクション全体が戻り、
    // drizzle-kit push へ進まないため、利用が落ち着いてから安全に再実行できる。
    await tx`SET LOCAL lock_timeout = '10s'`;

    const [tables] = await tx`
      SELECT
        to_regclass('nagi.bookmark_folders')::text AS folders,
        to_regclass('nagi.bookmarks')::text AS bookmarks
    `;
    if (!tables?.folders || !tables?.bookmarks) return "not-created";

    const primaryKeys = await tx`
      SELECT
        constraint_row.conname,
        constraint_row.contype,
        array_agg(attribute.attname ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
      JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        ON true
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_row.oid
        AND attribute.attnum = key_column.attnum
      WHERE schema_row.nspname = 'nagi'
        AND table_row.relname = 'bookmark_folders'
        AND constraint_row.contype = 'p'
      GROUP BY constraint_row.conname, constraint_row.contype
    `;
    const idPrimaryKey = primaryKeys.find(
      (row) =>
        row.contype === "p" &&
        row.columns.length === 1 &&
        row.columns[0] === "id",
    );
    if (idPrimaryKey) return "already-compatible";

    // drizzle-kit 自身の順序では、外部キーを戻してから参照先PKを削除して失敗する。
    // FKを外した状態で旧キーを削除し、UUIDの単一PKを作ってからFKを戻す。
    // UUID重複があればPK追加が失敗し、トランザクション全体がロールバックされる。
    await tx`LOCK TABLE "nagi"."bookmarks", "nagi"."bookmark_folders" IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE "nagi"."bookmarks" DROP CONSTRAINT IF EXISTS "nagi_bookmarks_folder_fk"`;
    for (const key of primaryKeys) {
      await tx`ALTER TABLE "nagi"."bookmark_folders" DROP CONSTRAINT ${tx(key.conname)}`;
    }
    await tx`ALTER TABLE "nagi"."bookmark_folders" DROP CONSTRAINT IF EXISTS "nagi_bookmark_folders_owner_id_unique"`;
    await tx`DROP INDEX IF EXISTS "nagi"."nagi_bookmark_folders_owner_id_idx"`;
    await tx`ALTER TABLE "nagi"."bookmark_folders" ADD CONSTRAINT "bookmark_folders_pkey" PRIMARY KEY ("id")`;
    await tx`
      ALTER TABLE "nagi"."bookmarks"
      ADD CONSTRAINT "nagi_bookmarks_folder_fk"
      FOREIGN KEY ("folder_id")
      REFERENCES "nagi"."bookmark_folders" ("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `;
    return "normalized";
  });

  if (result === "normalized") {
    console.log(
      "[drizzle:prepare] Normalized bookmark folder uniqueness for safe schema push.",
    );
  } else {
    console.log("[drizzle:prepare] Bookmark schema is already compatible.");
  }

  const recommendationResult = await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    const [existing] = await tx`
      SELECT
        to_regclass('nagi.news_reasons')::text AS reasons,
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'nagi' AND table_name = 'news_reasons' AND column_name = 'keyword'
        ) AS has_keyword,
        EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'nagi' AND table_name = 'news_reasons' AND column_name = 'genre'
        ) AS has_genre
    `;
    if (!existing?.reasons || existing.has_genre || !existing.has_keyword)
      return "already-compatible";

    // drizzle-kit に drop/add と誤認させず、旧い具体語の判定だけを破棄して列を改名する。
    await tx`LOCK TABLE "nagi"."news_reasons" IN ACCESS EXCLUSIVE MODE`;
    await tx`DELETE FROM "nagi"."news_reasons"`;
    await tx`ALTER TABLE "nagi"."news_reasons" RENAME COLUMN "keyword" TO "genre"`;
    await tx`
      UPDATE "nagi"."actors"
         SET "themes_checked_at" = NULL,
             "news_reasons_checked_at" = NULL
    `;
    return "renamed";
  });
  console.log(
    recommendationResult === "renamed"
      ? "[drizzle:prepare] Reset news recommendations for genre matching."
      : "[drizzle:prepare] News recommendation schema is already compatible.",
  );
} finally {
  await sql.end();
}
