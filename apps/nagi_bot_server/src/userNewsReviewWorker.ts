import {
  db,
  nagiNews,
  nagiNewsApprovals,
  nagiNewsReviewJobs,
} from "@bsky-affirmative-bot/database";
import {
  generateNewsComment,
  positiveNewsModel,
  type PositiveNewsCandidate,
} from "@bsky-affirmative-bot/bot-brain";
import { getNewsMetadata, LinkMetadataError } from "@bsky-affirmative-bot/nagi-linkcard";
import { httpsImageUrl } from "./newsImageUrl.js";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { startWorkerLoop } from "./workerLoop.js";

// News publication belongs to nagi_bot_server; biorhythm_server only owns bot-life state.
/** appview の userNewsSubmissions と同じ値。即時掲載（ポジティブ判定なし）の承認行の印。 */
const USER_NEWS_DIRECT_PROMPT_VERSION = "user-direct-v1";
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

type NewsRow = typeof nagiNews.$inferSelect;
type ApprovalRow = typeof nagiNewsApprovals.$inferSelect;

const jobKey = (job: ClaimedJob) =>
  and(
    eq(nagiNewsReviewJobs.newsUri, job.newsUri),
    eq(nagiNewsReviewJobs.newsCid, job.newsCid),
  );

/**
 * 即時掲載より前に積まれた pending ジョブ（承認行がまだ無い）を、appview の
 * requestNewsReview と同じ形で掲載する。ポジティブ判定はしない。
 * 掲載できなかったときは false を返し、ジョブの状態はここで確定させる。
 */
async function publishLegacyJob(
  job: ClaimedJob,
  news: NewsRow,
  candidate: PositiveNewsCandidate,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`news:${candidate.link}`}))`);
    const [current] = await tx
      .select({ cid: nagiNews.cid })
      .from(nagiNews)
      .where(and(eq(nagiNews.uri, news.uri), eq(nagiNews.cid, news.cid), isNull(nagiNews.deletedAt)))
      .limit(1);
    if (!current) {
      await tx
        .update(nagiNewsReviewJobs)
        .set({ status: "cancelled", reasonCode: "record_changed_or_deleted", finishedAt: new Date() })
        .where(jobKey(job));
      return false;
    }
    const [duplicate] = await tx
      .select({ uri: nagiNews.uri })
      .from(nagiNews)
      .innerJoin(
        nagiNewsApprovals,
        and(eq(nagiNewsApprovals.newsUri, nagiNews.uri), eq(nagiNewsApprovals.newsCid, nagiNews.cid)),
      )
      .where(
        and(
          eq(nagiNews.normalizedUrl, candidate.link!),
          ne(nagiNews.uri, news.uri),
          eq(nagiNewsApprovals.status, "approved"),
          isNull(nagiNews.deletedAt),
        ),
      )
      .limit(1);
    if (duplicate) {
      await tx
        .update(nagiNewsReviewJobs)
        .set({ status: "rejected", reasonCode: "duplicate_news", finishedAt: new Date() })
        .where(jobKey(job));
      return false;
    }
    await tx
      .update(nagiNews)
      .set({ normalizedUrl: candidate.link!, embedding: null })
      .where(and(eq(nagiNews.uri, news.uri), eq(nagiNews.cid, news.cid)));
    const snapshot = {
      snapshotArticleId: candidate.articleId,
      snapshotUrl: candidate.link!,
      snapshotTitleJa: candidate.title,
      snapshotSourceName: candidate.sourceName ?? null,
      snapshotSourceUrl: candidate.sourceUrl ?? null,
      snapshotImageUrl: candidate.imageUrl ?? null,
      snapshotPublishedAt: candidate.publishedAt ? new Date(candidate.publishedAt) : null,
      snapshotCreatedAt: news.recordCreatedAt,
    };
    await tx
      .insert(nagiNewsApprovals)
      .values({
        newsUri: news.uri,
        newsCid: news.cid,
        status: "approved",
        promptVersion: USER_NEWS_DIRECT_PROMPT_VERSION,
        ...snapshot,
      })
      // hiddenAt はここで戻さない。管理者が隠した事実は残す。
      .onConflictDoUpdate({
        target: [nagiNewsApprovals.newsUri, nagiNewsApprovals.newsCid],
        set: { status: "approved", ...snapshot },
      });
    return true;
  });
}

/** 承認行のスナップショットからコメント生成の材料を作る。記事の説明文は持っていない。 */
function candidateFromApproval(approval: ApprovalRow, news: NewsRow): PositiveNewsCandidate {
  return {
    articleId: approval.snapshotArticleId ?? articleIdFor(approval.snapshotUrl ?? news.url),
    title: approval.snapshotTitleJa ?? news.titleJa,
    description: undefined,
    sourceName: approval.snapshotSourceName ?? undefined,
    sourceUrl: approval.snapshotSourceUrl ?? undefined,
    imageUrl: approval.snapshotImageUrl ?? undefined,
    link: approval.snapshotUrl ?? news.url,
    publishedAt: approval.snapshotPublishedAt?.toISOString(),
    categories: [],
  };
}

/**
 * ユーザーが追加したニュースに botたんのコメントを書き足す。
 *
 * 掲載は appview の requestNewsReview が受け付けた時点で済んでいる（ポジティブ判定はしない）。
 * ここで扱うジョブは「コメント待ち」で、成功すれば approved、生成に失敗し続ければ failed。
 * どちらでも記事は掲載されたまま。
 */
export async function runUserNewsReviewBatch(now = new Date()): Promise<number> {
  const jobs = await claimJobs(now);
  let commented = 0;
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

    const [approval] = await db
      .select()
      .from(nagiNewsApprovals)
      .where(and(eq(nagiNewsApprovals.newsUri, job.newsUri), eq(nagiNewsApprovals.newsCid, job.newsCid)))
      .limit(1);

    // 説明文があるとコメントが的確になるので、記事ページは毎回読み直す。
    // 掲載済みの記事なら、読めなくてもスナップショットだけでコメントを書く。
    let candidate: PositiveNewsCandidate | undefined;
    try {
      const metadata = await getNewsMetadata(job.normalizedUrl);
      const canonicalUrl = normalizedUrl(metadata.uri);
      candidate = {
        articleId: articleIdFor(canonicalUrl),
        title: metadata.title,
        description: metadata.description,
        sourceName: metadata.siteName ?? new URL(metadata.uri).hostname,
        sourceUrl: new URL(metadata.uri).origin,
        imageUrl: httpsImageUrl(metadata.image),
        link: canonicalUrl,
        publishedAt: metadata.publishedAt,
        categories: [],
      };
    } catch (error) {
      if (!approval) {
        if (error instanceof LinkMetadataError && [400, 413, 415, 422].includes(error.status))
          await finish(job, "rejected", "metadata_unavailable");
        else await retry(job, "metadata_fetch_failed");
        continue;
      }
    }

    if (!approval && candidate && !(await publishLegacyJob(job, news, candidate))) continue;
    if (approval && candidate) candidate = { ...candidate, articleId: approval.snapshotArticleId ?? candidate.articleId };
    candidate ??= candidateFromApproval(approval!, news);

    let comment: Awaited<ReturnType<typeof generateNewsComment>>;
    try {
      comment = await generateNewsComment(candidate);
    } catch (error) {
      console.error("[ERROR][USER_NEWS] Comment generation failed", error);
      comment = undefined;
    }
    if (!comment) {
      await retry(job, "comment_failed");
      continue;
    }
    await db
      .update(nagiNewsApprovals)
      .set({
        botCommentJa: comment.botCommentJa,
        titleEn: comment.titleEn,
        botCommentEn: comment.botCommentEn,
        model: positiveNewsModel(),
      })
      .where(and(eq(nagiNewsApprovals.newsUri, job.newsUri), eq(nagiNewsApprovals.newsCid, job.newsCid)));
    await finish(job, "approved");
    commented++;
  }
  return commented;
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
