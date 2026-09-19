import {
  db,
  nagiNews,
  nagiNewsApprovals,
  nagiNewsReviewJobs,
} from "@bsky-affirmative-bot/database";
import {
  judgePositiveNewsBatch,
  positiveNewsModel,
  POSITIVE_NEWS_PROMPT_VERSION,
  type PositiveNewsCandidate,
} from "@bsky-affirmative-bot/bot-brain";
import { getNewsMetadata, LinkMetadataError } from "@bsky-affirmative-bot/nagi-linkcard";
import { httpsImageUrl } from "./newsImageUrl.js";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { startWorkerLoop } from "./workerLoop.js";

// News publication belongs to nagi_bot_server; biorhythm_server only owns bot-life state.
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 15 * 60 * 1000;

type ClaimedJob = typeof nagiNewsReviewJobs.$inferSelect;

const normalizedUrl = (raw: string) => {
  const url = new URL(raw);
  url.hash = "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) =>
    url.searchParams.delete(key),
  );
  return url.toString();
};

const articleIdFor = (url: string) =>
  `user:${createHash("sha256").update(url).digest("hex")}`;

async function claimJobs(now: Date): Promise<ClaimedJob[]> {
  const candidates = await db
    .select()
    .from(nagiNewsReviewJobs)
    .where(
      or(
        eq(nagiNewsReviewJobs.status, "pending"),
        and(
          eq(nagiNewsReviewJobs.status, "processing"),
          lt(nagiNewsReviewJobs.startedAt, new Date(now.getTime() - STALE_PROCESSING_MS)),
        ),
      ),
    )
    .orderBy(asc(nagiNewsReviewJobs.requestedAt))
    .limit(BATCH_SIZE);
  const claimed: ClaimedJob[] = [];
  for (const job of candidates) {
    const [row] = await db
      .update(nagiNewsReviewJobs)
      .set({ status: "processing", startedAt: now })
      .where(
        and(
          eq(nagiNewsReviewJobs.newsUri, job.newsUri),
          eq(nagiNewsReviewJobs.newsCid, job.newsCid),
          or(
            eq(nagiNewsReviewJobs.status, "pending"),
            and(
              eq(nagiNewsReviewJobs.status, "processing"),
              lt(nagiNewsReviewJobs.startedAt, new Date(now.getTime() - STALE_PROCESSING_MS)),
            ),
          ),
        ),
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

async function finish(
  job: ClaimedJob,
  status: "approved" | "rejected" | "failed" | "cancelled",
  reasonCode?: string,
) {
  await db
    .update(nagiNewsReviewJobs)
    .set({ status, reasonCode: reasonCode ?? null, finishedAt: new Date() })
    .where(
      and(
        eq(nagiNewsReviewJobs.newsUri, job.newsUri),
        eq(nagiNewsReviewJobs.newsCid, job.newsCid),
      ),
    );
}

async function retry(job: ClaimedJob, reasonCode: string) {
  const attemptCount = job.attemptCount + 1;
  await db
    .update(nagiNewsReviewJobs)
    .set({
      attemptCount,
      status: attemptCount >= MAX_ATTEMPTS ? "failed" : "pending",
      reasonCode,
      startedAt: null,
      finishedAt: attemptCount >= MAX_ATTEMPTS ? new Date() : null,
    })
    .where(
      and(
        eq(nagiNewsReviewJobs.newsUri, job.newsUri),
        eq(nagiNewsReviewJobs.newsCid, job.newsCid),
      ),
    );
}

export async function runUserNewsReviewBatch(now = new Date()): Promise<number> {
  const jobs = await claimJobs(now);
  if (!jobs.length) return 0;

  const prepared: Array<{
    job: ClaimedJob;
    news: typeof nagiNews.$inferSelect;
    candidate: PositiveNewsCandidate;
  }> = [];
  const preparedUrls = new Set<string>();
  for (const job of jobs) {
    const [news] = await db
      .select()
      .from(nagiNews)
      .where(
        and(
          eq(nagiNews.uri, job.newsUri),
          eq(nagiNews.cid, job.newsCid),
          eq(nagiNews.did, job.did),
          isNull(nagiNews.deletedAt),
        ),
      )
      .limit(1);
    if (!news) {
      await finish(job, "cancelled", "record_changed_or_deleted");
      continue;
    }
    try {
      const metadata = await getNewsMetadata(job.normalizedUrl);
      const canonicalUrl = normalizedUrl(metadata.uri);
      const [duplicate] = await db
        .select({ uri: nagiNews.uri })
        .from(nagiNews)
        .innerJoin(
          nagiNewsApprovals,
          and(
            eq(nagiNewsApprovals.newsUri, nagiNews.uri),
            eq(nagiNewsApprovals.newsCid, nagiNews.cid),
          ),
        )
        .where(
          and(
            eq(nagiNews.normalizedUrl, canonicalUrl),
            ne(nagiNews.uri, job.newsUri),
            eq(nagiNewsApprovals.status, "approved"),
            isNull(nagiNews.deletedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        await finish(job, "rejected", "duplicate_news");
        continue;
      }
      if (preparedUrls.has(canonicalUrl)) {
        await finish(job, "rejected", "duplicate_news");
        continue;
      }
      preparedUrls.add(canonicalUrl);
      prepared.push({
        job,
        news,
        candidate: {
          articleId: articleIdFor(canonicalUrl),
          title: metadata.title,
          description: metadata.description,
          sourceName: metadata.siteName ?? new URL(metadata.uri).hostname,
          sourceUrl: new URL(metadata.uri).origin,
          imageUrl: httpsImageUrl(metadata.image),
          link: canonicalUrl,
          publishedAt: metadata.publishedAt,
          categories: [],
        },
      });
    } catch (error) {
      if (error instanceof LinkMetadataError && [400, 413, 415, 422].includes(error.status))
        await finish(job, "rejected", "metadata_unavailable");
      else await retry(job, "metadata_fetch_failed");
    }
  }
  if (!prepared.length) return 0;

  let decisions: Awaited<ReturnType<typeof judgePositiveNewsBatch>>;
  try {
    decisions = await judgePositiveNewsBatch(prepared.map((item) => item.candidate));
  } catch (error) {
    console.error("[ERROR][USER_NEWS] Batch review failed", error);
    await Promise.all(prepared.map(({ job }) => retry(job, "review_failed")));
    return 0;
  }

  let approved = 0;
  for (const item of prepared) {
    const decision = decisions.find((candidate) => candidate.articleId === item.candidate.articleId);
    if (!decision) {
      await retry(item.job, "invalid_review_response");
      continue;
    }
    if (!decision.publishable) {
      if (decision.reasonCode === "positive_result") await retry(item.job, "comment_failed");
      else await finish(item.job, "rejected", decision.reasonCode);
      continue;
    }
    const snapshot = {
      snapshotArticleId: item.candidate.articleId,
      snapshotUrl: item.candidate.link!,
      snapshotTitleJa: item.candidate.title,
      snapshotSourceName: item.candidate.sourceName ?? null,
      snapshotSourceUrl: item.candidate.sourceUrl ?? null,
      snapshotImageUrl: item.candidate.imageUrl ?? null,
      snapshotPublishedAt: item.candidate.publishedAt ? new Date(item.candidate.publishedAt) : null,
      snapshotCreatedAt: item.news.recordCreatedAt,
    };
    const didApprove = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`news:${item.candidate.link}`}))`);
      const [current] = await tx
        .select({ cid: nagiNews.cid })
        .from(nagiNews)
        .where(
          and(
            eq(nagiNews.uri, item.news.uri),
            eq(nagiNews.cid, item.news.cid),
            isNull(nagiNews.deletedAt),
          ),
        )
        .limit(1);
      if (!current) {
        await tx
          .update(nagiNewsReviewJobs)
          .set({
            status: "cancelled",
            reasonCode: "record_changed_or_deleted",
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(nagiNewsReviewJobs.newsUri, item.job.newsUri),
              eq(nagiNewsReviewJobs.newsCid, item.job.newsCid),
            ),
          );
        return false;
      }
      const [duplicate] = await tx
        .select({ uri: nagiNews.uri })
        .from(nagiNews)
        .innerJoin(
          nagiNewsApprovals,
          and(
            eq(nagiNewsApprovals.newsUri, nagiNews.uri),
            eq(nagiNewsApprovals.newsCid, nagiNews.cid),
          ),
        )
        .where(
          and(
            eq(nagiNews.normalizedUrl, item.candidate.link!),
            ne(nagiNews.uri, item.news.uri),
            eq(nagiNewsApprovals.status, "approved"),
            isNull(nagiNews.deletedAt),
          ),
        )
        .limit(1);
      if (duplicate) {
        await tx
          .update(nagiNewsReviewJobs)
          .set({ status: "rejected", reasonCode: "duplicate_news", finishedAt: new Date() })
          .where(
            and(
              eq(nagiNewsReviewJobs.newsUri, item.job.newsUri),
              eq(nagiNewsReviewJobs.newsCid, item.job.newsCid),
            ),
          );
        return false;
      }
      await tx
        .update(nagiNews)
        .set({ normalizedUrl: item.candidate.link!, embedding: null })
        .where(
          and(eq(nagiNews.uri, item.news.uri), eq(nagiNews.cid, item.news.cid)),
        );
      await tx
        .insert(nagiNewsApprovals)
        .values({
          newsUri: item.news.uri,
          newsCid: item.news.cid,
          status: "approved",
          reasonCode: decision.reasonCode,
          botCommentJa: decision.botCommentJa,
          titleEn: decision.titleEn,
          botCommentEn: decision.botCommentEn,
          model: positiveNewsModel(),
          promptVersion: POSITIVE_NEWS_PROMPT_VERSION,
          ...snapshot,
        })
        .onConflictDoUpdate({
          target: [nagiNewsApprovals.newsUri, nagiNewsApprovals.newsCid],
          set: {
            status: "approved",
            reasonCode: decision.reasonCode,
            botCommentJa: decision.botCommentJa,
            titleEn: decision.titleEn,
            botCommentEn: decision.botCommentEn,
            model: positiveNewsModel(),
            promptVersion: POSITIVE_NEWS_PROMPT_VERSION,
            hiddenAt: null,
            ...snapshot,
          },
        });
      await tx
        .update(nagiNewsReviewJobs)
        .set({ status: "approved", reasonCode: decision.reasonCode, finishedAt: new Date() })
        .where(
          and(
            eq(nagiNewsReviewJobs.newsUri, item.job.newsUri),
            eq(nagiNewsReviewJobs.newsCid, item.job.newsCid),
          ),
        );
      return true;
    });
    if (didApprove) approved++;
  }
  return approved;
}

export function scheduleUserNewsReviews() {
  // 1分に最大5件。失敗を同じtickで即時再試行せず、次回まで間を置く。
  const timer = startWorkerLoop({
    name: "USER_NEWS",
    intervalMs: 60_000,
    tick: runUserNewsReviewBatch,
    immediate: true,
  });
  timer.unref();
  return timer;
}
