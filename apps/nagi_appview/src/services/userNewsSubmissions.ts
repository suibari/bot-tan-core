import { createHash } from "node:crypto";
import {
  db,
  nagiNews,
  nagiNewsApprovals,
  nagiModerationDecisions,
  nagiNewsReviewJobs,
} from "@bsky-affirmative-bot/database";
import { type MyNewsSubmissions, type NewsSubmissionPreview } from "@bsky-affirmative-bot/nagi-lexicon";
import { getNewsMetadata } from "@bsky-affirmative-bot/nagi-linkcard";
import { and, count, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import { wakeModerationWorker } from "../ingest/moderationWorker.js";
import { ensurePdsRecord } from "../ingest/reconcileRepo.js";
import { ApiError } from "../middleware/errors.js";
import { toApiError } from "../util/linkCardError.js";
import {
  jstDayStart,
  normalizeNewsUrl,
  submissionStatus,
  validateNewsReviewSubject,
} from "./userNewsSubmissionPolicy.js";

const articleIdFor = (normalizedUrl: string) =>
  `user:${createHash("sha256").update(normalizedUrl).digest("hex")}`;

/** 一覧はOGP画像を配信元から直接読むので、混在コンテンツにならない https だけ残す。 */
const httpsImageUrl = (value: string | undefined) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/** 即時掲載した承認行の印。ポジティブ判定を通していないことを後から区別できるようにする。 */
export const USER_NEWS_DIRECT_PROMPT_VERSION = "user-direct-v1";

export async function getNewsSubmissionPreview(rawUrl: string): Promise<NewsSubmissionPreview> {
  const metadata = await toApiError(() => getNewsMetadata(rawUrl));
  const normalizedUrl = normalizeNewsUrl(metadata.uri);
  const duplicate = await db
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
        eq(nagiNews.normalizedUrl, normalizedUrl),
        eq(nagiNewsApprovals.status, "approved"),
        isNull(nagiNews.deletedAt),
      ),
    )
    .limit(1);
  if (duplicate.length)
    throw new ApiError(409, "duplicate_news", "This article has already been added");
  const parsed = new URL(normalizedUrl);
  return {
    articleId: articleIdFor(normalizedUrl),
    url: normalizedUrl,
    title: metadata.title,
    sourceName: metadata.siteName ?? parsed.hostname,
    sourceUrl: parsed.origin,
    ...(metadata.publishedAt ? { publishedAt: metadata.publishedAt } : {}),
    ...(metadata.image ? { image: metadata.image } : {}),
  };
}

/**
 * ユーザーが追加したニュースを受け付け、その場で掲載する。
 *
 * 以前は LLM のポジティブ判定を通ってから掲載していたが、今は判定しない。
 * 不適切なものは自動モデレーション（タイトルと OGP 画像）が札を付けて CW で伏せ、
 * それでも残ったものは運用者が `news:feed:hide` で隠す。
 *
 * botたんのコメントはここでは作らない。ジョブを pending で積み、
 * nagi_bot_server の userNewsReviewWorker が後から承認行へ書き足す。
 * スナップショットはクライアントが書いたレコードではなく、サーバーが読み直した
 * メタデータから作る（hasTrustedSnapshot の前提）。
 */
export async function requestNewsReview(
  viewerDid: string,
  subject: { uri: string; cid: string },
) {
  const parsed = validateNewsReviewSubject(viewerDid, subject);

  let ensured: Awaited<ReturnType<typeof ensurePdsRecord>>;
  try {
    ensured = await ensurePdsRecord(parsed.did, parsed.collection, parsed.rkey);
  } catch {
    throw new ApiError(409, "invalid_record", "News record could not be verified on the PDS");
  }
  // 審査依頼はレコードが実在することが前提なので、PDS に無ければ従来どおり弾く。
  if (ensured.status !== "present")
    throw new ApiError(409, "invalid_record", "News record could not be verified on the PDS");
  const current = ensured.record;
  if (current.uri !== subject.uri || current.cid !== subject.cid)
    throw new ApiError(409, "invalid_record", "News record CID does not match");

  const [news] = await db
    .select()
    .from(nagiNews)
    .where(and(eq(nagiNews.uri, subject.uri), eq(nagiNews.cid, subject.cid), isNull(nagiNews.deletedAt)))
    .limit(1);
  if (!news || news.did !== viewerDid)
    throw new ApiError(409, "invalid_record", "News record is not indexed");

  const metadata = await toApiError(() => getNewsMetadata(news.url));
  const canonicalUrl = normalizeNewsUrl(metadata.uri);
  const source = new URL(canonicalUrl);

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${viewerDid}))`);
    const [existing] = await tx
      .select({ status: nagiNewsReviewJobs.status })
      .from(nagiNewsReviewJobs)
      .where(and(eq(nagiNewsReviewJobs.newsUri, subject.uri), eq(nagiNewsReviewJobs.newsCid, subject.cid)))
      .limit(1);
    if (existing) return { status: existing.status };

    const now = new Date();
    const [usage] = await tx
      .select({ value: count() })
      .from(nagiNewsReviewJobs)
      .where(and(eq(nagiNewsReviewJobs.did, viewerDid), gte(nagiNewsReviewJobs.requestedAt, jstDayStart(now))));
    if (Number(usage?.value ?? 0) >= config.userNewsDailyLimit)
      throw new ApiError(429, "news_daily_limit", "Daily news submission limit reached");

    // 同じ記事の同時追加を1件に絞る。worker の承認トランザクションと同じ鍵。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`news:${canonicalUrl}`}))`);
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
          eq(nagiNews.normalizedUrl, canonicalUrl),
          ne(nagiNews.uri, subject.uri),
          eq(nagiNewsApprovals.status, "approved"),
          isNull(nagiNews.deletedAt),
        ),
      )
      .limit(1);
    if (duplicate)
      throw new ApiError(409, "duplicate_news", "This article has already been added");

    await tx
      .update(nagiNews)
      // 判定待ちへ戻し、OGP画像込みでモデレーションし直す（札が付けば CW で伏せる）。
      .set({ normalizedUrl: canonicalUrl, embedding: null, moderationVersion: null })
      .where(and(eq(nagiNews.uri, subject.uri), eq(nagiNews.cid, subject.cid)));
    // 取り込み時の判定（見出しだけ・画像なし）は同じ cid のキャッシュとして再利用されて
    // しまうので消しておく。運用者が解除した判定（override）は残す。
    await tx
      .delete(nagiModerationDecisions)
      .where(
        and(
          eq(nagiModerationDecisions.uri, subject.uri),
          eq(nagiModerationDecisions.cid, subject.cid),
          isNull(nagiModerationDecisions.override),
        ),
      );
    const snapshot = {
      snapshotArticleId: articleIdFor(canonicalUrl),
      snapshotUrl: canonicalUrl,
      snapshotTitleJa: metadata.title,
      snapshotSourceName: metadata.siteName ?? source.hostname,
      snapshotSourceUrl: source.origin,
      snapshotImageUrl: httpsImageUrl(metadata.image),
      snapshotPublishedAt: metadata.publishedAt ? new Date(metadata.publishedAt) : null,
      snapshotCreatedAt: news.recordCreatedAt,
    };
    await tx
      .insert(nagiNewsApprovals)
      .values({
        newsUri: subject.uri,
        newsCid: subject.cid,
        status: "approved",
        promptVersion: USER_NEWS_DIRECT_PROMPT_VERSION,
        ...snapshot,
      })
      .onConflictDoUpdate({
        target: [nagiNewsApprovals.newsUri, nagiNewsApprovals.newsCid],
        // hiddenAt は戻さない。運用者が隠した事実は残す。
        set: { status: "approved", ...snapshot },
      });
    // ジョブは「botたんのコメント待ち」を表す。掲載そのものは上の承認行で済んでいる。
    await tx.insert(nagiNewsReviewJobs).values({
      newsUri: subject.uri,
      newsCid: subject.cid,
      did: viewerDid,
      normalizedUrl: canonicalUrl,
      requestedAt: now,
    });
    return { status: "approved" as const };
  });
  wakeModerationWorker();
  return result;
}

export async function getMyNewsSubmissions(viewerDid: string, limit: number): Promise<MyNewsSubmissions> {
  const rows = await db
    .select({
      job: nagiNewsReviewJobs,
      news: nagiNews,
      approvalStatus: nagiNewsApprovals.status,
      hiddenAt: nagiNewsApprovals.hiddenAt,
    })
    .from(nagiNewsReviewJobs)
    .innerJoin(nagiNews, eq(nagiNews.uri, nagiNewsReviewJobs.newsUri))
    .leftJoin(
      nagiNewsApprovals,
      and(
        eq(nagiNewsApprovals.newsUri, nagiNewsReviewJobs.newsUri),
        eq(nagiNewsApprovals.newsCid, nagiNewsReviewJobs.newsCid),
      ),
    )
    .where(eq(nagiNewsReviewJobs.did, viewerDid))
    .orderBy(desc(nagiNewsReviewJobs.requestedAt))
    .limit(Math.min(20, Math.max(1, limit)));
  return {
    items: rows.map(({ job, news, approvalStatus, hiddenAt }) => ({
      uri: job.newsUri,
      cid: job.newsCid,
      url: news.url,
      title: news.titleJa,
      status: submissionStatus(job.status, approvalStatus, hiddenAt),
      ...(job.reasonCode ? { reasonCode: job.reasonCode } : {}),
      requestedAt: job.requestedAt.toISOString(),
      ...(job.finishedAt ? { finishedAt: job.finishedAt.toISOString() } : {}),
    })),
  };
}

