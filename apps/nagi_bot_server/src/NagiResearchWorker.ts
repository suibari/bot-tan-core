import {
  completeResearchJob,
  failResearchJob,
  leaseResearchJob,
  pruneResearchJobs,
  tryUpsertBotMemoryDocument,
} from "@bsky-affirmative-bot/database";
import { aiModel, isAiGroundingEnabled } from "@bsky-affirmative-bot/shared-configs";
import { planResearch, researchSelfHosted } from "@bsky-affirmative-bot/bot-brain";

const MAX_ATTEMPTS = 3;
const LEASE_DURATION_MS = 300_000;
/**
 * 検索はリプライの同期パスから外れているので急がない。
 *
 * ここを短くしても得は無い。リプライ生成と同じ 26B を奪い合うと Ollama の runner が
 * 取り合いになってリプライが遅くなり、非同期にした意味が消える。**同時実行は 1**。
 */
const WORKER_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
/** 事実は腐るので、完了ジョブごと捨てて再調査できるようにする。 */
const JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

let running = false;

/**
 * 非同期リサーチワーカー。
 *
 * リプライはその場では「知らない」と答え、調べる仕事はここへ回る。結果は
 * bot memory（source_type='web_research'）へ入り、次に同じ話題が来たときに
 * nagiReplyContext の検索が拾う。追いリプライはしない。
 */
export function startNagiResearchWorker() {
  if (running) return;
  if (!isAiGroundingEnabled()) {
    console.log("[INFO][RESEARCH_WORKER] AI_GROUNDING_PROVIDER=off のため起動しない");
    return;
  }
  running = true;

  const run = async () => {
    const job = await leaseResearchJob(LEASE_DURATION_MS);
    if (!job) return;

    try {
      // 生入力を見るのはローカル planner だけ。検索側へ渡るのは planner が作った
      // 検索語と、本文から拾った URL に限る（同期パス時代からの契約）。
      const plan = await planResearch(aiModel("GROUNDING_RESEARCH"), job.subject, true);
      if (!plan.queries.length && !plan.urls.length) {
        throw new Error("Research planner returned no safe query or URL");
      }
      const research = await researchSelfHosted({
        queries: plan.queries,
        urls: plan.urls,
      });

      // sourceId をジョブのハッシュに揃える。再調査すると同じ行が更新され、
      // bot_memory_source_key_idx の unique がそのまま重複防止になる。
      await tryUpsertBotMemoryDocument({
        sourceType: "web_research",
        sourceId: job.subjectHash,
        content: research,
        occurredAt: new Date(),
        metadata: { queries: plan.queries, urls: plan.urls },
      });
      await completeResearchJob(job.subjectHash);
      console.log(
        `[INFO][RESEARCH_WORKER] done queries=${plan.queries.length} urls=${plan.urls.length}`,
      );
    } catch (error) {
      const backoffMs = Math.min(MAX_BACKOFF_MS, 2 ** job.attempts * 60_000);
      // 調べられなくてもリプライは既に「知らない」と答えて成立している。
      // ここで失敗しても利用者には何も起きない。
      await failResearchJob({
        subjectHash: job.subjectHash,
        attempts: job.attempts,
        maxAttempts: MAX_ATTEMPTS,
        backoffMs,
        error,
      });
      console.warn(
        `[WARN][RESEARCH_WORKER] attempt=${job.attempts} 失敗`,
        error instanceof Error ? error.message : error,
      );
    }
  };

  setInterval(() => {
    void run().catch(console.error);
  }, WORKER_INTERVAL_MS).unref();

  setInterval(() => {
    void pruneResearchJobs(JOB_RETENTION_MS)
      .then((count) => {
        if (count) console.log(`[INFO][RESEARCH_WORKER] pruned ${count} jobs`);
      })
      .catch(console.error);
  }, PRUNE_INTERVAL_MS).unref();
}
