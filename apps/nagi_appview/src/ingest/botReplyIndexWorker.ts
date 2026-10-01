import { startWorkerLoop } from "@bsky-affirmative-bot/bot-runtime";
import { db, nagiBotReplyJobs, nagiPosts } from "@bsky-affirmative-bot/database";
import { and, asc, eq, gt, like, lt, notExists } from "drizzle-orm";
import { config } from "../config.js";
import { parseRecordUri } from "./recordUri.js";
import { ensurePdsRecord } from "./reconcileRepo.js";

/**
 * 「botたんは返信を投稿済みなのに、AppView にその返信が無い」状態の監視と回収。
 *
 * 返信は投稿直後に nagi_bot_server が取り込みを依頼するので、通常はここに何も残らない。
 * 依頼の HTTP が落ちた・AppView が再起動中だった、といった取りこぼしだけを拾う。
 * 件数は監視にも出す。0 でなければ、即時反映の経路がどこかで壊れている。
 *
 * 間隔はユーザーの待ち時間に乗らない（即時反映の口が別にある）ので、1分で足りる。
 */
const INTERVAL_MS = 60_000;
/** 依頼の HTTP がまだ処理中かもしれない間は触らない。 */
const GRACE_MS = 2 * 60_000;
/** これより古いジョブは見ない。返信を消した・PDS から消えたものを永遠に数え続けないため。 */
const LOOKBACK_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 20;

export type UnindexedBotReplies = {
  unindexedBotReplies: number;
  oldestUnindexedReplyMs?: number;
  checkedAt?: string;
};

let latest: UnindexedBotReplies = { unindexedBotReplies: 0 };
/** PDS からも消えていた返信。AppView に無いのが正しいので、以後は数えない。 */
const absentOnPds = new Set<string>();

/** nagi-appview のハートビートに載せる直近の集計。 */
export const unindexedBotReplies = (): UnindexedBotReplies => latest;

/**
 * 投稿済みなのに AppView に無い返信を古い順に引く。
 * 日時は型付き演算子で比べる（raw sql へ Date を補間すると postgres.js が落ちる）。
 */
export function selectUnindexedBotReplies(now: Date, limit: number) {
  return db
    .select({
      sourceUri: nagiBotReplyJobs.sourceUri,
      replyUri: nagiBotReplyJobs.replyUri,
      updatedAt: nagiBotReplyJobs.updatedAt,
    })
    .from(nagiBotReplyJobs)
    .where(
      and(
        eq(nagiBotReplyJobs.state, "posted"),
        // こっそりの返信は AppView 発行の URI で、PDS に正本が無いので対象外。
        like(nagiBotReplyJobs.replyUri, `at://${config.botDid}/%`),
        lt(nagiBotReplyJobs.updatedAt, new Date(now.getTime() - GRACE_MS)),
        gt(nagiBotReplyJobs.updatedAt, new Date(now.getTime() - LOOKBACK_MS)),
        notExists(
          db
            .select({ uri: nagiPosts.uri })
            .from(nagiPosts)
            .where(eq(nagiPosts.uri, nagiBotReplyJobs.replyUri)),
        ),
      ),
    )
    .orderBy(asc(nagiBotReplyJobs.updatedAt))
    .limit(limit);
}

export async function recoverUnindexedBotReplies(
  now = new Date(),
): Promise<UnindexedBotReplies> {
  const candidates = await selectUnindexedBotReplies(
    now,
    BATCH_SIZE + absentOnPds.size,
  );
  const rows = candidates
    .filter((row) => !absentOnPds.has(row.replyUri ?? ""))
    .slice(0, BATCH_SIZE);

  let recovered = 0;
  for (const row of rows) {
    const parsed = parseRecordUri(row.replyUri);
    if (!parsed) continue;
    try {
      const ensured = await ensurePdsRecord(
        parsed.did,
        parsed.collection,
        parsed.rkey,
      );
      if (ensured.status === "present") recovered++;
      else absentOnPds.add(row.replyUri ?? "");
      console.warn("[WARN][BOT_REPLY_INDEX] Recovered unindexed bot reply", {
        replyUri: row.replyUri,
        status: ensured.status,
        waitedMs: now.getTime() - row.updatedAt.getTime(),
      });
    } catch (error) {
      console.error("[ERROR][BOT_REPLY_INDEX] Failed to recover bot reply", {
        replyUri: row.replyUri,
        error,
      });
    }
  }

  // 監視に出すのは「回収する前に見つかった件数」。0 でないこと自体が異常の合図なので、
  // 回収できたかどうかで打ち消さない。
  latest = {
    unindexedBotReplies: rows.length,
    ...(rows[0]
      ? { oldestUnindexedReplyMs: now.getTime() - rows[0].updatedAt.getTime() }
      : {}),
    checkedAt: now.toISOString(),
  };
  if (rows.length)
    console.warn("[WARN][BOT_REPLY_INDEX] Bot replies were missing from AppView", {
      found: rows.length,
      recovered,
    });
  return latest;
}

export function startBotReplyIndexWorker(): NodeJS.Timeout {
  const timer = startWorkerLoop({
    name: "BOT_REPLY_INDEX",
    intervalMs: INTERVAL_MS,
    tick: () => recoverUnindexedBotReplies(),
  });
  timer.unref();
  return timer;
}
