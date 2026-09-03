/**
 * 埋め込みモデルを差し替えたあとの全件再埋め込み。
 *
 *   npx tsx --env-file=.env scripts/reembedAll.mts            # ドライラン（件数だけ表示）
 *   npx tsx --env-file=.env scripts/reembedAll.mts --run      # 実行
 *   npx tsx --env-file=.env scripts/reembedAll.mts --reindex  # 完了後の HNSW 再構築だけ
 *
 * やることは「embedding を NULL に落とす」だけ。各アプリの常駐ワーカーが
 * `embedding IS NULL` を舐めて埋め直す設計なので、生成はワーカーに任せる:
 *   - nagi_appview  の embeddingWorker           … posts / profiles / channels / news
 *   - biorhythm_server の botMemoryEmbeddingWorker … bot_memory_documents
 *
 * 例外は affirmative_bot.posts。ここだけワーカーが無く upsertPost 時にしか埋まらないので、
 * このスクリプトが直接埋める（十数件なので即終わる）。
 *
 * 次元が変わるモデルへ移る場合はこのスクリプトだけでは足りない（列の作り直しが要る）。
 * 1024次元同士の差し替え専用。
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  bot_memory_documents,
  client,
  db,
  nagiChannels,
  nagiNews,
  nagiPosts,
  nagiProfiles,
  posts,
} from "../packages/database/src/db.js";
import { generateEmbedding } from "../packages/database/src/ollamaEmbed.js";

const argv = new Set(process.argv.slice(2));
const RUN = argv.has("--run");
const REINDEX_ONLY = argv.has("--reindex");

/** NULL に落とす対象。順序は「小さい表から」＝失敗時の影響を見やすくするため。 */
const targets = [
  { label: "nagi.channels", table: nagiChannels },
  { label: "nagi.profiles", table: nagiProfiles },
  { label: "nagi.news", table: nagiNews },
  { label: "nagi.posts", table: nagiPosts },
  { label: "affirmative_bot.bot_memory_documents", table: bot_memory_documents },
] as const;

/** HNSW は全行更新でかなり荒れるので、再埋め込みが終わったら貼り直す。 */
const hnswIndexes = [
  "nagi.nagi_channels_embedding_hnsw_idx",
  "nagi.nagi_profiles_embedding_hnsw_idx",
  "nagi.nagi_news_embedding_hnsw_idx",
  "nagi.nagi_posts_embedding_hnsw_idx",
  "affirmative_bot.bot_memory_embedding_hnsw_idx",
];

async function counts() {
  const rows: { label: string; total: number; embedded: number }[] = [];
  for (const { label, table } of targets) {
    const [r] = await db
      .select({
        total: sql<number>`count(*)::int`,
        embedded: sql<number>`count(${table.embedding})::int`,
      })
      .from(table);
    rows.push({ label, total: r.total, embedded: r.embedded });
  }
  const [p] = await db
    .select({
      total: sql<number>`count(*)::int`,
      embedded: sql<number>`count(${posts.embedding})::int`,
    })
    .from(posts);
  rows.push({ label: "affirmative_bot.posts（直接埋める）", total: p.total, embedded: p.embedded });
  return rows;
}

function report(rows: Awaited<ReturnType<typeof counts>>) {
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(w)}  全 ${String(r.total).padStart(6)} 行 / 埋込済 ${String(r.embedded).padStart(6)}`,
    );
  }
  console.log(
    `  ${"合計".padEnd(w)}  全 ${String(rows.reduce((a, r) => a + r.total, 0)).padStart(6)} 行 / 埋込済 ${String(rows.reduce((a, r) => a + r.embedded, 0)).padStart(6)}`,
  );
}

async function reindex() {
  for (const idx of hnswIndexes) {
    process.stdout.write(`  reindex ${idx} … `);
    const started = Date.now();
    // concurrently はトランザクション外でしか使えない。db.execute は暗黙 tx を張らないのでそのまま通る。
    await db.execute(sql.raw(`reindex index concurrently ${idx}`));
    console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

async function main() {
  if (REINDEX_ONLY) {
    console.log("HNSW インデックスを再構築します（再埋め込み完了後に実行すること）。");
    if (!RUN) {
      console.log("ドライラン。対象:\n  " + hnswIndexes.join("\n  "));
      console.log("\n実行するには --reindex --run を付けてください。");
      return;
    }
    await reindex();
    return;
  }

  console.log("現在の埋め込み状況:");
  report(await counts());

  if (!RUN) {
    console.log(
      "\nドライランです。--run を付けると上記すべての embedding を NULL に落とします。" +
        "\n落としたあとは各アプリの常駐ワーカーが埋め直します（1.5〜2時間程度）。" +
        "\nその間、意味検索は縮退します（語彙検索・ILIKE 一致は無傷）。",
    );
    return;
  }

  console.log("\nembedding を NULL に落とします …");
  for (const { label, table } of targets) {
    const started = Date.now();
    // bot_memory_documents は embedding_model が「どのモデルで埋めたか」を持つので一緒に消す。
    // 再埋め込みの進捗はこの列を group by すれば見える。
    const extra =
      table === bot_memory_documents ? { embedding_model: null } : {};
    const updated = await db
      .update(table)
      .set({ embedding: null, ...extra })
      .where(isNotNull(table.embedding))
      .returning({ one: sql<number>`1` });
    console.log(
      `  ${label}: ${updated.length} 行 (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  }

  // ワーカーが無い表だけ自前で埋める。
  const pending = await db
    .select({ did: posts.did, post: posts.post })
    .from(posts)
    .where(and(isNull(posts.embedding), isNotNull(posts.post)));
  console.log(`\naffirmative_bot.posts を直接埋めます（${pending.length} 行）…`);
  let filled = 0;
  for (const row of pending) {
    if (!row.post) continue;
    const embedding = await generateEmbedding(row.post);
    if (!embedding) {
      console.warn(`  [WARN] 埋め込み取得に失敗: ${row.did}（Ollama 不通? 後で再実行してください）`);
      continue;
    }
    await db.update(posts).set({ embedding }).where(eq(posts.did, row.did));
    filled++;
  }
  console.log(`  ${filled}/${pending.length} 行を埋めました。`);

  console.log("\n完了。ワーカーの進捗はこれで見られます:");
  console.log(
    "  select embedding_model, count(*) from affirmative_bot.bot_memory_documents group by 1;",
  );
  console.log("\n埋め終わったら HNSW を貼り直してください:");
  console.log("  npx tsx --env-file=.env scripts/reembedAll.mts --reindex --run");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end({ timeout: 5 }).catch(() => {});
  });
