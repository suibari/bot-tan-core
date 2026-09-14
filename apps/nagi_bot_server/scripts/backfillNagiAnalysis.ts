/**
 * 名刺（自動分析）が一度も生成されていないユーザーを洗い出して、後から分析を流す。
 *
 * 分析が撃たれる機会は「Nagi 初回登録」「Nagi 投稿10件」「100件ごと」しか無く、
 * どれも取りこぼすと名刺が出ないまま残る。実際に起きたのは、
 *   - 初回ジョブが Gemini の 503 でリトライを使い切って failed のまま止まった
 *   - bot がブロックされていて Bluesky を読めず、初回がスキップされた
 *   - 自動分析機能のリリース前に登録していて、そもそもジョブが立たなかった
 * の3種類。10件発火も「既に10件を超えている人」には二度と来ないので、その回収もここで行う。
 *
 * enqueue は force で冪等キーをユニークにするため、failed / posted で固まった行があっても通る。
 *
 * Preview（対象を数えるだけ。Gemini は呼ばない）:
 *   pnpm --filter nagi-bot-server analysis:backfill
 * Apply（キューに積んでワーカーに任せる）:
 *   pnpm --filter nagi-bot-server analysis:backfill --apply
 * Bluesky に投稿が無い Nagi 専用ユーザーを Nagi 投稿で分析する:
 *   pnpm --filter nagi-bot-server analysis:backfill --source=nagi --apply
 * ユーザーを絞る / その場で生成して中身を見る:
 *   pnpm --filter nagi-bot-server analysis:backfill did:plc:xxx --sync
 * 既に名刺がある人を作り直す（プロンプト修正後の上書き）。DID を明示したときだけ通る:
 *   pnpm --filter nagi-bot-server analysis:backfill did:plc:xxx --source=nagi --sync
 * 本人に通知せず、こっそり中身だけ差し替える:
 *   pnpm --filter nagi-bot-server analysis:backfill did:plc:xxx --source=nagi --sync --silent
 * 書き込まずに、生成結果だけ見る:
 *   pnpm --filter nagi-bot-server analysis:backfill did:plc:xxx --source=nagi --dry-run
 */
import { desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  nagiActorAnalyses,
  nagiActors,
  nagiAnalysisJobs,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  enqueueAnalysis,
  runNagiAnalysis,
  type AnalysisSource,
} from "../src/NagiAnalysisFeature.js";
import { initAgent } from "../src/agent.js";

// pnpm 6 までの区切り記号。今は不要だが、付けて呼ばれても落ちないよう捨てる。
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const apply = args.includes("--apply");
const sync = args.includes("--sync");
// 本人への通知（通知行 + Web Push）を出さずに中身だけ差し替える。プロンプトを直した
// あとの作り直しで「また名刺が更新された」と鳴らさないため。--sync のときだけ効く
// （キュー経由はワーカーが通常どおり通知する）。
const silent = args.includes("--silent");
// 生成して中身を見るだけ。DB には何も書かない（通知も出ない）。
const dryRun = args.includes("--dry-run");
// キューに積まず、その場で実行する経路。
const runInline = sync || dryRun;
const sourceArg = args
  .find((arg) => arg.startsWith("--source="))
  ?.slice("--source=".length);
const dids = args.filter((arg) => !arg.startsWith("--"));
const unknown = args.filter(
  (arg) =>
    arg.startsWith("--") &&
    arg !== "--apply" &&
    arg !== "--sync" &&
    arg !== "--silent" &&
    arg !== "--dry-run" &&
    !arg.startsWith("--source="),
);

function usage(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    "usage: analysis:backfill [did:plc:... ...] [--source=bluesky|nagi] [--apply] [--sync] [--silent] [--dry-run]",
  );
  process.exit(1);
}

if (unknown.length) usage(`unknown option: ${unknown.join(", ")}`);
// キュー経由はワーカーが通常どおり通知するので、--silent が黙って効かないのを防ぐ。
if (silent && !runInline) {
  usage("--silent は --sync と一緒に使うこと（キュー経由の実行では通知を止められない）");
}
if (sourceArg && sourceArg !== "bluesky" && sourceArg !== "nagi") {
  usage(`invalid --source: ${sourceArg}`);
}
const source: AnalysisSource = (sourceArg as AnalysisSource) ?? "bluesky";
for (const did of dids) {
  if (!/^did:(plc|web):/.test(did)) usage(`invalid DID: ${did}`);
}

const botDid = process.env.NAGI_BOT_DID;

// 分析行が無い Nagi ユーザー。ジョブの状態も一緒に引いて、なぜ落ちたのかを preview で読めるようにする。
const rows = await db
  .select({
    did: nagiProfiles.did,
    handle: nagiActors.handle,
    createdAt: nagiProfiles.createdAt,
    jobState: nagiAnalysisJobs.state,
    lastError: nagiAnalysisJobs.lastError,
  })
  .from(nagiProfiles)
  .leftJoin(nagiActors, eq(nagiActors.did, nagiProfiles.did))
  .leftJoin(nagiActorAnalyses, eq(nagiActorAnalyses.did, nagiProfiles.did))
  // 初回ジョブだけを見る（100件ごとのジョブは分析行が残るので、ここには出てこない）。
  .leftJoin(
    nagiAnalysisJobs,
    eq(nagiAnalysisJobs.id, sql`${nagiProfiles.did} || '#first'`),
  )
  // DID を明示したときは、分析済みの人も対象にする（＝作り直し）。プロンプトを直した
  // あとに特定の人の名刺を作り直す口が他に無い（/analysis/run の force / sync は
  // NODE_ENV=development 限定）。DID 無しの一括実行は従来どおり「分析行が無い人」だけ。
  .where(dids.length ? undefined : isNull(nagiActorAnalyses.did))
  .orderBy(desc(nagiProfiles.createdAt));

// Nagi 投稿数。--source=nagi のときは 0 件だと分析できないので preview で見えるようにする。
const counts = await db
  .select({ did: nagiPosts.did, count: sql<number>`count(*)::int` })
  .from(nagiPosts)
  .where(isNull(nagiPosts.deletedAt))
  .groupBy(nagiPosts.did);
const postCountByDid = new Map(counts.map((row) => [row.did, row.count]));

// botたん自身は ingest のフックでも分析対象外なので、ここでも同じ扱いにする。
const targets = rows
  .filter((row) => row.did !== botDid)
  .filter((row) => dids.length === 0 || dids.includes(row.did));

const missing = dids.filter((did) => !targets.some((row) => row.did === did));
if (missing.length) {
  console.warn(
    `[WARN] 指定された次の DID は対象外（Nagi プロフィール無し or botたん自身）: ${missing.join(", ")}`,
  );
}

console.log(
  `${dryRun ? "DRY-RUN" : apply || sync ? "APPLY" : "PREVIEW"}: source=${source}, 対象 ${targets.length} 人（${
    dids.length ? "指定された DID。分析済みなら作り直す" : "分析行が無い Nagi ユーザー"
  }）`,
);
for (const target of targets) {
  const nagiPostCount = postCountByDid.get(target.did) ?? 0;
  const job = target.jobState ?? "(no job)";
  const err = target.lastError ? `  err=${target.lastError.slice(0, 120)}` : "";
  console.log(
    `  ${target.did}  ${target.handle ?? "?"}  joined=${target.createdAt?.toISOString().slice(0, 10) ?? "?"}  nagiPosts=${nagiPostCount}  job=${job}${err}`,
  );
}

if (!apply && !runInline) {
  console.log("何も書いていない。実行するなら --apply（または --sync）を付ける。");
  process.exit(0);
}
if (targets.length === 0) {
  console.log("対象なし。");
  process.exit(0);
}

// gatherBlueskyInput が bot agent で author feed を読むので、先にログインしておく。
await initAgent();

let queued = 0;
let done = 0;
let skipped = 0;
let failed = 0;
for (const [index, target] of targets.entries()) {
  const progress = `[${index + 1}/${targets.length}]`;
  try {
    if (runInline) {
      // キューを介さず直接実行する。「no posts」でスキップされたことがその場で分かる。
      const result = await runNagiAnalysis(
        {
          did: target.did,
          source,
          // 「何件時点の分析か」の記録。null のままだと作り直すたびに記録だけが劣化する。
          // 次回の自動発火は nagi.posts の実件数で決まるので、ここの値は判定に影響しない。
          postCountAt:
            source === "nagi" ? (postCountByDid.get(target.did) ?? null) : null,
        },
        { notify: !silent, dryRun },
      );
      if (result.skipped) {
        skipped += 1;
        console.log(`${progress} ${target.did}: SKIPPED (${result.reason})`);
      } else {
        done += 1;
        console.log(
          `${progress} ${target.did}: ${dryRun ? "GENERATED (書いていない)" : "OK"}`,
        );
        console.log(`  tagline: ${result.result.taglineJa}`);
        console.log(`  tags   : ${result.result.tagsJa.join(" / ")}`);
        // dry-run は中身を見るための実行なので本文まで出す。
        if (dryRun) console.log(`  analysis: ${result.result.analysisJa}`);
      }
    } else {
      // force で冪等キーをユニークにする。failed / posted で固まった行があっても通る。
      await enqueueAnalysis({ did: target.did, source, force: true });
      queued += 1;
      console.log(`${progress} ${target.did}: queued`);
    }
  } catch (error) {
    failed += 1;
    console.error(`${progress} ${target.did}: FAILED`, error);
  }
}

if (runInline) {
  console.log(
    dryRun
      ? `done: ${done} generated (dry-run。DB には書いていない), ${skipped} skipped, ${failed} failed`
      : `done: ${done} written, ${skipped} skipped, ${failed} failed`,
  );
} else {
  console.log(
    `done: ${queued} queued, ${failed} failed（生成はワーカーが順次行う。数分後に nagi.actor_analyses を確認すること）`,
  );
}
process.exit(failed ? 1 : 0);
