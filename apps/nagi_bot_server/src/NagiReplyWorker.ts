import { and, asc, eq, lte, or } from "drizzle-orm";
import {
  db,
  nagiBotReplyJobs,
  nagiPostScores,
  nagiPosts,
  shouldRememberAffirmedPost,
  tryUpsertBotMemoryDocument,
} from "@bsky-affirmative-bot/database";
import {
  SUPER_POSITIVE_SCORE_THRESHOLD,
  awardSuperPositiveLevel,
} from "@bsky-affirmative-bot/clients";
import { createNagiReply } from "./createNagiReply.js";
import {
  decideNagiReplyMode,
  NagiAiQuotaExceededError,
  reserveNagiAiRequest,
  switchNagiReplyToTemplate,
} from "./nagiAiQuota.js";
import {
  classifyNagiReplyError,
  formatNagiReplyError,
  isDegenerateGenerationError,
  nagiAiRouteForAttempt,
  nextNagiReplyAttemptAt,
} from "./nagiReplyRetry.js";

const LEASE_DURATION_MS = 15 * 60_000;
const WORKER_INTERVAL_MS = 2_000;

/**
 * この試行のあとに再試行の余地が無いか（＝24時間の期限切れ、または段の打ち止め）。
 * 判定はラダー本体と同じ関数で行うので、遅延表と条件が二重管理にならない。
 */
function isFinalAttempt(job: { createdAt: Date }, attempt: number): boolean {
  return (
    nextNagiReplyAttemptAt({
      attempt,
      category: "transient",
      createdAt: job.createdAt,
      now: new Date(),
    }) === undefined
  );
}

let running = false;
let processing = false;

export function startNagiReplyWorker() {
  if (running) {
    return;
  }

  if (!/^did:(plc|web):/.test(process.env.NAGI_BOT_DID ?? "")) {
    throw new Error("NAGI_BOT_DID must be an AT Protocol DID");
  }

  running = true;

  const run = async () => {
    const now = new Date();
    const jobs = await db
      .select()
      .from(nagiBotReplyJobs)
      .where(
        and(
          or(
            eq(nagiBotReplyJobs.state, "pending"),
            eq(nagiBotReplyJobs.state, "processing"),
          ),
          lte(nagiBotReplyJobs.nextAttemptAt, now),
          or(
            eq(nagiBotReplyJobs.state, "pending"),
            lte(nagiBotReplyJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(nagiBotReplyJobs.nextAttemptAt))
      .limit(1);

    const job = jobs[0];
    if (!job) {
      return;
    }

    const attempt = job.attempts + 1;
    // このワーカーへ入る返信付き投稿は bot 宛会話だけなので、会話は初回から
    // createNagiReply の実態どおり flash/Standard として扱う。
    const conversationMode = Boolean((job.recordJson as any)?.reply);
    const aiRoute = nagiAiRouteForAttempt(conversationMode ? 5 : attempt);
    await db
      .update(nagiBotReplyJobs)
      .set({
        state: "processing",
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        attempts: attempt,
        updatedAt: now,
      })
      .where(eq(nagiBotReplyJobs.sourceUri, job.sourceUri));

    let generationMode: "ai" | "template" | undefined;
    try {
      // bot宛返信はAI/定型/最終的な生成成否を問わず「受けた入力」として残す。
      // AppViewの公開判定が確定した行だけを採用する。こっそりも覚えるが、
      // visibility="kossori" を付けて「本人がこっそりで話しているときだけ」引けるようにする。
      const incomingRecord = job.recordJson as any;
      if (incomingRecord?.reply && typeof incomingRecord.text === "string") {
        const [receivedPost] = await db
          .select({
            kossori: nagiPosts.kossori,
            deletedAt: nagiPosts.deletedAt,
          })
          .from(nagiPosts)
          .where(eq(nagiPosts.uri, job.sourceUri))
          .limit(1);
        if (receivedPost && !receivedPost.deletedAt) {
          await tryUpsertBotMemoryDocument({
            sourceType: "nagi_received_reply",
            sourceId: job.sourceUri,
            sourceUri: job.sourceUri,
            authorId: job.authorDid,
            content: incomingRecord.text,
            occurredAt: new Date(incomingRecord.createdAt ?? job.createdAt),
            visibility: receivedPost.kossori ? "kossori" : "public",
            metadata: { receivedByBot: true },
          });
        }
      }

      const decision = await decideNagiReplyMode(job.sourceUri, job.authorDid);
      generationMode = decision.mode;
      let result;
      try {
        result = await createNagiReply(job, {
          mode: decision.mode,
          beforeGeminiRequest:
            decision.mode === "ai" ? reserveNagiAiRequest : undefined,
          aiRoute,
        });
      } catch (error) {
        if (error instanceof NagiAiQuotaExceededError) {
          await switchNagiReplyToTemplate(job.sourceUri, error.reason);
          generationMode = "template";
          result = await createNagiReply(job, { mode: "template" });
        } else if (isDegenerateGenerationError(error) && isFinalAttempt(job, attempt)) {
          // 生成物が壊れたままラダーを使い切った。無言で消えるより定型文で返す。
          console.warn(
            `[WARN][NAGI] ${job.sourceUri} falling back to a predefined reply after a degenerate generation:`,
            formatNagiReplyError(error),
          );
          generationMode = "template";
          result = await createNagiReply(job, { mode: "template" });
        } else {
          throw error;
        }
      }

      await db.transaction(async (tx) => {
        // 会話モードの返信はスコアを持たないので post_scores には積まない。
        // botReply の紐付けは bot_reply_jobs.reply_uri 側で維持される。
        if (result.score !== undefined) {
          await tx
            .insert(nagiPostScores)
            .values({
              postUri: job.sourceUri,
              score: result.score,
              botReplyUri: result.uri,
            })
            .onConflictDoUpdate({
              target: nagiPostScores.postUri,
              set: {
                score: result.score,
                botReplyUri: result.uri,
                updatedAt: new Date(),
              },
            });
        }

        await tx
          .update(nagiBotReplyJobs)
          .set({
            state: "posted",
            replyUri: result.uri,
            score: result.score ?? null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(nagiBotReplyJobs.sourceUri, job.sourceUri));
      });

      // AppView が確定した可視範囲を正とする。行がまだ無い場合は、こっそりを誤って
      // public として覚えるより安全なので次回のバックフィルへ任せる。
      const [sourcePost] = await db
        .select({
          kossori: nagiPosts.kossori,
          deletedAt: nagiPosts.deletedAt,
        })
        .from(nagiPosts)
        .where(eq(nagiPosts.uri, job.sourceUri))
        .limit(1);
      const record = job.recordJson as any;

      if (sourcePost && typeof record?.text === "string" && shouldRememberAffirmedPost({
        surface: "nagi",
        aiReplyPosted: generationMode === "ai",
        isTopLevel: !record.reply,
        sourceAlive: !sourcePost.deletedAt,
      })) {
        await tryUpsertBotMemoryDocument({
          sourceType: "nagi_affirmed_post",
          sourceId: job.sourceUri,
          sourceUri: job.sourceUri,
          authorId: job.authorDid,
          content: record.text,
          botResponse: null,
          occurredAt: new Date(record.createdAt ?? job.createdAt),
          visibility: sourcePost.kossori ? "kossori" : "public",
          affirmationScore: result.score ?? null,
          metadata: { replyUri: result.uri, generationMode: "ai" },
        });
      }

      // 超ポジティブLvはBlueskyと共通のカウンタ（followers.positivity_level）。
      // ジョブは既に posted なので、ここでの失敗はログのみ（リトライで二重加算させない）。
      if (
        result.score !== undefined &&
        result.score >= SUPER_POSITIVE_SCORE_THRESHOLD
      ) {
        try {
          await awardSuperPositiveLevel(job.authorDid);
        } catch (error) {
          console.error(
            `[ERROR][BADGE] Failed to award positivity level for ${job.authorDid}:`,
            error,
          );
        }
      }
    } catch (error) {
      const failedAt = new Date();
      const classification = classifyNagiReplyError(error);
      const nextAttemptAt = nextNagiReplyAttemptAt({
        attempt,
        category: classification.category,
        createdAt: job.createdAt,
        now: failedAt,
      });
      const lastError = formatNagiReplyError(error);

      console.warn(
        JSON.stringify({
          level: "warn",
          event: "nagi_reply_failed",
          sourceUri: job.sourceUri,
          attempt,
          generationMode: generationMode ?? "undecided",
          ...(generationMode === "ai"
            ? {
                model: aiRoute.model,
                serviceTier: aiRoute.serviceTier,
              }
            : {}),
          category: classification.category,
          ...(classification.status !== undefined
            ? { status: classification.status }
            : {}),
          ...(classification.code ? { code: classification.code } : {}),
          ...(nextAttemptAt
            ? { state: "pending", nextAttemptAt: nextAttemptAt.toISOString() }
            : { state: "failed" }),
          error: lastError,
        }),
      );

      await db
        .update(nagiBotReplyJobs)
        .set({
          state: nextAttemptAt ? "pending" : "failed",
          lastError,
          leaseExpiresAt: null,
          nextAttemptAt: nextAttemptAt ?? failedAt,
          updatedAt: failedAt,
        })
        .where(eq(nagiBotReplyJobs.sourceUri, job.sourceUri));
    }
  };

  setInterval(() => {
    if (processing) return;
    processing = true;
    void run()
      .catch(console.error)
      .finally(() => {
        processing = false;
      });
  }, WORKER_INTERVAL_MS);
}
