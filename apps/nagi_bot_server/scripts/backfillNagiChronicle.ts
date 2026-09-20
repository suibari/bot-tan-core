/**
 * 既存ユーザーの過去の月を、自分年表のロールアップ対象として積む。
 *
 * **このスクリプトは Ollama を呼ばない。** やるのは nagi.chronicle_jobs への
 * エンキューだけで、生成は NagiChronicleWorker が毎分1件ずつ消化する。
 * スクリプトから直接 LLM を叩くと startWorkerLoop の直列性を迂回することになり、
 * 同じ Ollama を共用している別アプリまで巻き込む（AGENTS.md の 2026-09-02 の実測を参照）。
 * リース・バックオフ・再起動耐性も、ワーカーに任せればそのまま手に入る。
 *
 * Preview（対象を数えるだけ。何も書かない）:
 *   pnpm --filter nagi-bot-server chronicle:backfill
 * 範囲を絞る:
 *   pnpm --filter nagi-bot-server chronicle:backfill --from=2026-01 --to=2026-08
 * ユーザーを絞る:
 *   pnpm --filter nagi-bot-server chronicle:backfill did:plc:xxx --apply
 * 一度に積む件数を切る（段階的に流したいとき）:
 *   pnpm --filter nagi-bot-server chronicle:backfill --apply --limit=500
 */
import { and, asc, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { db, nagiDiaries } from "@bsky-affirmative-bot/database";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import { enqueueChronicleMonths } from "../src/NagiChronicleFeature.js";

/** ワーカーの間隔（1 tick 1件・60秒）。所要時間の見積もりに使う。 */
const WORKER_MINUTES_PER_JOB = 1;

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const apply = args.includes("--apply");
const from = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
const to = args.find((a) => a.startsWith("--to="))?.slice("--to=".length);
const limitArg = args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
const dids = args.filter((arg) => !arg.startsWith("--"));
const unknown = args.filter(
  (arg) =>
    arg.startsWith("--") &&
    arg !== "--apply" &&
    !arg.startsWith("--from=") &&
    !arg.startsWith("--to=") &&
    !arg.startsWith("--limit="),
);

function usage(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    "usage: chronicle:backfill [did:plc:... ...] [--from=YYYY-MM] [--to=YYYY-MM] [--limit=N] [--apply]",
  );
  process.exit(1);
}

if (unknown.length) usage(`unknown option: ${unknown.join(", ")}`);
for (const month of [from, to]) {
  if (month && !/^\d{4}-\d{2}$/.test(month)) usage(`invalid month: ${month}`);
}
for (const did of dids) {
  if (!/^did:(plc|web):/.test(did)) usage(`invalid DID: ${did}`);
}
const limit = limitArg ? Number(limitArg) : undefined;
if (limitArg && (!Number.isInteger(limit) || limit! <= 0))
  usage(`invalid --limit: ${limitArg}`);

// 今月はまだ閉じていない。「大きな出来事」は月の中での相対比較なので、途中では決めない。
const currentMonth = cardDrawDate().slice(0, 7);
const upper = to && to < currentMonth ? to : currentMonth;
if (to && to >= currentMonth)
  console.warn(
    `[WARN] --to=${to} は閉じていない月を含む。${currentMonth} より前だけを対象にする。`,
  );

const monthExpr = sql<string>`substr(${nagiDiaries.diaryDate}, 1, 7)`;
const rows = await db
  .select({
    subjectDid: nagiDiaries.subjectDid,
    month: monthExpr,
    diaryCount: sql<number>`count(*)::int`,
  })
  .from(nagiDiaries)
  .where(
    and(
      // 今月は必ず外す。「大きな出来事」は月の中での相対比較なので、途中では決めない。
      lt(monthExpr, currentMonth),
      ...(upper !== currentMonth ? [lte(monthExpr, upper)] : []),
      ...(from ? [gte(monthExpr, from)] : []),
      ...(dids.length ? [inArray(nagiDiaries.subjectDid, dids)] : []),
    ),
  )
  .groupBy(nagiDiaries.subjectDid, monthExpr)
  .orderBy(asc(monthExpr));

const targets = limit ? rows.slice(0, limit) : rows;
const users = new Set(targets.map((row) => row.subjectDid)).size;
const minutes = targets.length * WORKER_MINUTES_PER_JOB;

console.log(
  `対象: ${targets.length} (did, month) / ${users} 人` +
    (limit && rows.length > limit ? `（--limit で ${rows.length} 件から絞った）` : ""),
);
console.log(
  `ワーカーは毎分1件なので、積んだぶんを消化するのに約 ${minutes} 分（${(minutes / 60).toFixed(1)} 時間）かかる。`,
);
for (const row of targets.slice(0, 20))
  console.log(`  ${row.subjectDid} ${row.month} (${row.diaryCount} 日記)`);
if (targets.length > 20) console.log(`  … ほか ${targets.length - 20} 件`);

if (!apply) {
  console.log("何も書いていない。積むなら --apply を付ける。");
  process.exit(0);
}
if (!targets.length) {
  console.log("対象なし。");
  process.exit(0);
}

const inserted = await enqueueChronicleMonths(targets);
console.log(
  `done: ${inserted} 件を積んだ（残り ${targets.length - inserted} 件はすでにジョブがある）。`,
);
console.log("生成は NagiChronicleWorker が毎分1件ずつ進める。");
process.exit(0);
