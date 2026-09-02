import {
  completeResearchJob,
  failResearchJob,
  leaseResearchJob,
  pruneResearchJobs,
  tryUpsertBotMemoryDocument,
} from "@bsky-affirmative-bot/database";
import { isAiGroundingEnabled } from "@bsky-affirmative-bot/shared-configs";
import {
  isSearxngConfigured,
  researchKnowledgeCardSelfHosted,
} from "@bsky-affirmative-bot/bot-brain";

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
 * **記憶の一部なので Nagi ではなく biorhythm_server に置く。** 入口は Bluesky・Nagi の
 * リプライでモデルが「知らなかった」と申告した語と、記憶から抽出された印象ラベル
 * （YouTube 配信のコメント由来を含む）。検索上位ページを横断した統合知識カードを、
 * 全サーフェス共通の bot_memory_documents（source_type='web_research'）へ保存する。
 * botMemoryEmbeddingWorker / botMemoryImpressionWorker と同じ並び。
 *
 * その場では「知らない」と正直に答えたうえで、ここで調べて次に同じ対象が来たときに
 * 使えるようにする。追いリプライはしない。
 */
export function startBotMemoryResearchWorker() {
  if (running) return;
  if (!isAiGroundingEnabled()) {
    console.log("[INFO][MEMORY_RESEARCH] AI_GROUNDING_PROVIDER=off のため起動しない");
    return;
  }
  // 検索基盤が無いまま回すと、積まれたジョブを失敗させて指数バックオフで
  // 潰すだけになる。SearXNG を立てる前の初回デプロイがまさにこの状態。
  if (!isSearxngConfigured()) {
    console.warn(
      "[WARN][MEMORY_RESEARCH] SEARXNG_BASE_URL が未設定のため起動しない。" +
        " searxng/compose.yml で立ててから .env に書くこと。",
    );
    return;
  }
  running = true;

  const run = async () => {
    const job = await leaseResearchJob(LEASE_DURATION_MS);
    if (!job) return;

    try {
      // ジョブに入っているのは調べる語そのもの。何を調べるかは既に決まっているので
      // planner は要らず、非同期側の LLM 呼び出しは最後の要約 1 回だけ。
      //
      // 素の固有名詞は検索クエリとしてよく効く（実測:「薬屋のひとりごと」で公式
      // サイトと Wikipedia の infobox が取れる）。
      const research = await researchKnowledgeCardSelfHosted(job.subject);

      // sourceId をジョブのハッシュに揃える。再調査すると同じ行が更新され、
      // bot_memory_source_key_idx の unique がそのまま重複防止になる。
      await tryUpsertBotMemoryDocument({
        sourceType: "web_research",
        sourceId: job.subjectHash,
        // 語そのものを本文に含める。次に同じ語が出たとき、意味検索でも
        // 部分一致検索でも引けるようにするため。
        content: `${job.subject}\n${research}`,
        occurredAt: new Date(),
        metadata: { term: job.subject, format: "knowledge_card_v1" },
      });
      await completeResearchJob(job.subjectHash);
      console.log(`[INFO][MEMORY_RESEARCH] learned: ${job.subject}`);
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
        `[WARN][MEMORY_RESEARCH] attempt=${job.attempts} 失敗`,
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
        if (count) console.log(`[INFO][MEMORY_RESEARCH] pruned ${count} jobs`);
      })
      .catch(console.error);
  }, PRUNE_INTERVAL_MS).unref();
}
