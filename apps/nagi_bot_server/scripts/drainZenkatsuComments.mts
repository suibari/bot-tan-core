/*
 * 開発補助: ゼンカツの総評を、溜まっているぶんだけその場で書く。
 *
 * 本来は nagi_bot_server の NagiZenkatsuWorker が回すが、あのプロセスは起動時に
 * Bluesky へログインするため、認証情報が無い開発環境では総評まで到達できない。
 * 総評の生成自体はログインに一切依存しないので、ここだけを切り出して回せるようにする。
 *
 *   pnpm --filter @bsky-affirmative-bot/nagi-bot-server zenkatsu:drain
 *
 * 引数に提出 URI を渡すと、その1件だけを対象にする。
 */
import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiZenkatsuCommentJobs } from "@bsky-affirmative-bot/database";
import { runNagiZenkatsu } from "../src/NagiZenkatsuFeature.js";

const only = process.argv[2];

const jobs = only
  ? [{ submissionUri: only, attempts: 0 }]
  : await db
      .select({
        submissionUri: nagiZenkatsuCommentJobs.submissionUri,
        attempts: nagiZenkatsuCommentJobs.attempts,
      })
      .from(nagiZenkatsuCommentJobs)
      .where(
        and(
          or(
            eq(nagiZenkatsuCommentJobs.state, "pending"),
            eq(nagiZenkatsuCommentJobs.state, "processing"),
          ),
          lte(nagiZenkatsuCommentJobs.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(nagiZenkatsuCommentJobs.nextAttemptAt));

if (!jobs.length) {
  console.log("[zenkatsu:drain] 生成待ちの総評はありません。");
  process.exit(0);
}

console.log(`[zenkatsu:drain] ${jobs.length}件を処理します。`);
let ok = 0;
for (const job of jobs) {
  try {
    await runNagiZenkatsu(job.submissionUri);
    await db
      .update(nagiZenkatsuCommentJobs)
      .set({ state: "posted", leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(nagiZenkatsuCommentJobs.submissionUri, job.submissionUri));
    ok += 1;
    console.log(`  OK  ${job.submissionUri}`);
  } catch (e) {
    // 失敗しても残りは試す。本番のワーカーと同じく、総評が付かないだけで提出は残る。
    console.error(`  NG  ${job.submissionUri}:`, e instanceof Error ? e.message : e);
  }
}
console.log(`[zenkatsu:drain] 完了: ${ok}/${jobs.length}`);
process.exit(0);
