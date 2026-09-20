import { and, asc, eq, lte, or } from "drizzle-orm";
import { db, nagiChronicleJobs, nagiChronicleNews } from "@bsky-affirmative-bot/database";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import {
  processChronicleMonth,
  processChronicleNews,
  sweepChronicleJobs,
  sweepChronicleNews,
} from "./NagiChronicleFeature.js";
import { startWorkerLoop } from "./workerLoop.js";

const MAX_ATTEMPTS = 5;
const LEASE_DURATION_MS = 300_000;
/**
 * 1 tick 1件。**これがそのまま Ollama へのレート制御になる**（最大で毎分1リクエスト）。
 *
 * 年表は「月が変わってから作るもの」で、待っているユーザーが居ない。AGENTS.md の
 * 「間隔の決め方」のとおり、詰めても体感は変わらず並列だけが増える経路なので短くしない。
 * バックフィルで数千ジョブ積んでも、この間隔のままゆっくり消化させる。
 */
const WORKER_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 900_000;
/** 1 tick で積むジョブの上限。バックフィル直後に全件を一度に舐めない。 */
const SWEEP_LIMIT = 200;

let running = false;

/**
 * 自分年表の月次ロールアップワーカー。
 *
 * **「月が閉じた」を cron ではなく条件で表現する。** 対象は cardDrawDate（JST 4:00 始まり）で
 * 見た今月より前の月だけ。サーバのタイムゾーンにもワーカーの起動時刻にも依存せず、
 * 落ちていた間のぶんも起動後に古い月から自然に片付く（ZENKATSU_AWARD と同じ形）。
 */
export function startNagiChronicleWorker() {
  if (running) return;
  running = true;

  const run = async () => {
    const now = new Date();
    const currentMonth = cardDrawDate(now).slice(0, 7);
    await sweepChronicleJobs(currentMonth, SWEEP_LIMIT);
    await sweepChronicleNews(currentMonth);

    /*
     * 「そのころ世の中では」を1件。**全ユーザー共通なので月に1回しか走らない。**
     * 利用者ぶんのロールアップより先に片付ける（件数が桁違いに少なく、
     * 先に通しておけば年表の背景が早く揃う）。
     */
    if (await runPendingNews(now)) return;

    const jobs = await db
      .select()
      .from(nagiChronicleJobs)
      .where(
        and(
          or(
            eq(nagiChronicleJobs.state, "pending"),
            eq(nagiChronicleJobs.state, "processing"),
          ),
          lte(nagiChronicleJobs.nextAttemptAt, now),
          or(
            eq(nagiChronicleJobs.state, "pending"),
            lte(nagiChronicleJobs.leaseExpiresAt, now),
          ),
        ),
      )
      // 古い月から。年表が古い順に埋まるほうが、途中で見に来たときの見え方が自然。
      .orderBy(asc(nagiChronicleJobs.month))
      .limit(1);

    const job = jobs[0];
    if (!job) return;
    const key = and(
      eq(nagiChronicleJobs.subjectDid, job.subjectDid),
      eq(nagiChronicleJobs.month, job.month),
    );

    await db
      .update(nagiChronicleJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(key);

    try {
      const result = await processChronicleMonth(job.subjectDid, job.month);
      await db
        .update(nagiChronicleJobs)
        .set({
          state: "posted",
          // 次の sweep がこの件数と突き合わせて、遅れて入った日記を拾う。
          diaryCount: result.diaryCount,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(key);
    } catch (error) {
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 10_000);
      // 上限まで失敗しても、年表から LLM のイベントが欠けるだけ。記念日カードも
      // 「はじめて」もニュースも決定論で出るので、年表そのものは成立し続ける。
      await db
        .update(nagiChronicleJobs)
        .set({
          state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(key);
    }
  };

  return startWorkerLoop({
    name: "NAGI_CHRONICLE",
    intervalMs: WORKER_INTERVAL_MS,
    tick: run,
  });
}

/** 待っている月のニュースを1件だけ確定する。処理したら true。 */
async function runPendingNews(now: Date): Promise<boolean> {
  const rows = await db
    .select()
    .from(nagiChronicleNews)
    .where(
      and(
        or(
          eq(nagiChronicleNews.state, "pending"),
          eq(nagiChronicleNews.state, "processing"),
        ),
        lte(nagiChronicleNews.nextAttemptAt, now),
        or(
          eq(nagiChronicleNews.state, "pending"),
          lte(nagiChronicleNews.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(nagiChronicleNews.month))
    .limit(1);
  const job = rows[0];
  if (!job) return false;
  const key = eq(nagiChronicleNews.month, job.month);

  await db
    .update(nagiChronicleNews)
    .set({
      state: "processing",
      leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      attempts: job.attempts + 1,
      updatedAt: now,
    })
    .where(key);

  try {
    // 成功時の 'posted' への確定は processChronicleNews が中で行う。
    await processChronicleNews(job.month);
  } catch (error) {
    const attempts = job.attempts + 1;
    const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** attempts * 10_000);
    // 上限まで失敗しても、欠けるのは背景の1行だけ。年表そのものは成立し続ける。
    await db
      .update(nagiChronicleNews)
      .set({
        state: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        lastError: error instanceof Error ? error.message : String(error),
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        updatedAt: new Date(),
      })
      .where(key);
  }
  return true;
}
