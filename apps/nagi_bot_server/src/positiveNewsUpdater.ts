import { createHash } from "node:crypto";
import { db, nagiNews, nagiNewsApprovals, nagiNewsCandidates, nagiNewsScreening, nagiNewsUpdateRuns, pickNewsInterestTopic, recordNewsInterestTopicYield } from "@bsky-affirmative-bot/database";
import { getPositiveNewsCandidates, isNewsInterestGenre, judgePositiveNewsBatch, POSITIVE_NEWS_PROMPT_VERSION, positiveNewsModel } from "@bsky-affirmative-bot/bot-brain";
import { and, asc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { publishNews } from "./NagiNewsFeature.js";
import { resolveNewsImageUrl } from "./newsImageUrl.js";
import { startWorkerLoop } from "./workerLoop.js";
import type { PositiveNewsCandidate } from "@bsky-affirmative-bot/bot-brain";
import { requestClientRebuild } from "./clientDeployHook.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const RETRY_DELAY = 30 * 60 * 1000;
const JST_OFFSET = 9 * 60 * 60 * 1000;
// 1スロットで掲載する最大件数と、その日次上限（掲載数 / NewsDataクレジット）。
const MAX_PER_SLOT = 5;
const DAILY_PUBLISH_LIMIT = 20;
const DAILY_CREDIT_LIMIT = 20;
/**
 * 未掲載候補を在庫に置いておく期間。ニュースとしての鮮度が切れたら出さない。
 * 一覧の14日窓より短くして、在庫経由で掲載された記事にも一覧に居る時間を残す。
 */
const CANDIDATE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * 1スロットで関心ジャンル指定に使うページ数。
 *
 * 最大2ページまで見る。NewsData の q は本文全体検索で、先頭ページが告知・販促に
 * 偏ることがあるため、10件だけでは広いジャンルでも候補を取りこぼしやすい。
 * 1スロットの上限3ページは変えず、残り1ページは無指定取得へ回して供給を切らさない。
 */
const TOPIC_PAGES = 2;
/**
 * 同じジャンルを再び取得に使えるようになるまで。1日4スロットなので、上位ジャンルが
 * 日替わりで回る。
 */
const TOPIC_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function newsSlot(now = new Date()): Date {
  return new Date(Math.floor((now.getTime() + JST_OFFSET) / SIX_HOURS) * SIX_HOURS - JST_OFFSET);
}

function normalizedUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw); url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch { return undefined; }
}

async function claim(slot: Date): Promise<boolean> {
  const inserted = await db.insert(nagiNewsUpdateRuns).values({ slot, status: "running" }).onConflictDoNothing().returning({ slot: nagiNewsUpdateRuns.slot });
  if (inserted.length) return true;
  const retry = await db.update(nagiNewsUpdateRuns).set({ status: "running", retryCount: 1, startedAt: new Date(), lastError: null })
    .where(and(eq(nagiNewsUpdateRuns.slot, slot), eq(nagiNewsUpdateRuns.status, "failed"), eq(nagiNewsUpdateRuns.retryCount, 0), lt(nagiNewsUpdateRuns.finishedAt, new Date(Date.now() - RETRY_DELAY))))
    .returning({ slot: nagiNewsUpdateRuns.slot });
  return retry.length > 0;
}


/**
 * 粗選別を通ったが今回積まれなかった記事を在庫へ入れる。
 *
 * NewsData のクレジットは取得の時点で払い済みなので、ここで捨てずに残すぶんには
 * 追加コストがゼロ。次のスロットが NewsData を叩く前にここから審査へ回せる。
 */
async function stockCandidates(
  candidates: PositiveNewsCandidate[],
  now: Date,
): Promise<void> {
  const rows = candidates.flatMap((item) => {
    const url = normalizedUrl(item.link);
    if (!item.link || !url) return [];
    return [{
      articleId: item.articleId,
      normalizedUrl: url,
      url: item.link,
      titleJa: item.title,
      description: item.description ?? null,
      sourceName: item.sourceName ?? null,
      sourceUrl: item.sourceUrl ?? null,
      imageUrl: item.imageUrl ?? null,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      expiresAt: new Date(now.getTime() + CANDIDATE_TTL_MS),
    }];
  });
  if (!rows.length) return;
  // 既に在庫にある記事は expires_at を延ばさない（古い記事が居座らないように）。
  await db.insert(nagiNewsCandidates).values(rows).onConflictDoNothing();
}

/**
 * getCandidates の戻り値は TARGET_CANDIDATES で切られているので、粗選別を通った記事の
 * 全量は diagnostics 側から拾う。取得した各ページは必ず最後まで分類されており、
 * ここで捨てていたぶんがそのまま在庫になる。
 */
function acceptedArticles(
  result: Awaited<ReturnType<typeof getPositiveNewsCandidates>>,
): PositiveNewsCandidate[] {
  return result.diagnostics.decisions
    .filter((d) => d.decision === "accept")
    .map((d) => d.article);
}

/** 在庫から審査に回せる記事を取り出す。古い順＝拾った順に消化する。 */
async function takeStock(
  limit: number,
  excludedArticleIds: Set<string>,
  now: Date,
): Promise<PositiveNewsCandidate[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select()
    .from(nagiNewsCandidates)
    .where(
      and(
        isNull(nagiNewsCandidates.promotedNewsUri),
        gt(nagiNewsCandidates.expiresAt, now),
        excludedArticleIds.size
          ? notInArray(nagiNewsCandidates.articleId, [...excludedArticleIds])
          : undefined,
      ),
    )
    .orderBy(asc(nagiNewsCandidates.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    articleId: row.articleId,
    title: row.titleJa,
    description: row.description ?? undefined,
    sourceName: row.sourceName ?? undefined,
    sourceUrl: row.sourceUrl ?? undefined,
    imageUrl: row.imageUrl ?? undefined,
    link: row.url,
    publishedAt: row.publishedAt?.toISOString(),
    categories: [],
  }));
}

export async function updatePositiveNews(now = new Date()): Promise<number> {
  const slot = newsSlot(now);
  if (!(await claim(slot))) return 0;
  let creditsUsed = 0;
  try {
    const dayStartMs = Math.floor((now.getTime() + JST_OFFSET) / 86_400_000) * 86_400_000 - JST_OFFSET;
    const countRows = await db.select({ count: sql<number>`coalesce(sum(${nagiNewsUpdateRuns.publishedCount}), 0)` }).from(nagiNewsUpdateRuns)
      .where(and(gt(nagiNewsUpdateRuns.slot, new Date(dayStartMs - 1)), lt(nagiNewsUpdateRuns.slot, new Date(dayStartMs + 86_400_000))));
    const remaining = Math.max(0, DAILY_PUBLISH_LIMIT - Number(countRows[0]?.count ?? 0));
    if (!remaining) {
      await db.update(nagiNewsUpdateRuns).set({ status: "complete", finishedAt: new Date() }).where(eq(nagiNewsUpdateRuns.slot, slot));
      return 0;
    }
    const creditRows = await db.select({ count: sql<number>`coalesce(sum(${nagiNewsUpdateRuns.newsDataCredits}), 0)` }).from(nagiNewsUpdateRuns)
      .where(and(gt(nagiNewsUpdateRuns.slot, new Date(dayStartMs - 1)), lt(nagiNewsUpdateRuns.slot, new Date(dayStartMs + 86_400_000))));
    const remainingCredits = Math.max(0, DAILY_CREDIT_LIMIT - Number(creditRows[0]?.count ?? 0));
    // PDS作成後に承認保存だけ失敗したレコードは、次回再審査・再承認できるよう除外しない。
    const existing = await db.select({ articleId: nagiNews.articleId, normalizedUrl: nagiNews.normalizedUrl })
      .from(nagiNews).innerJoin(nagiNewsApprovals, and(eq(nagiNewsApprovals.newsUri, nagiNews.uri), eq(nagiNewsApprovals.newsCid, nagiNews.cid)))
      .where(and(isNull(nagiNews.deletedAt), eq(nagiNewsApprovals.status, "approved")));
    const recentRejected = await db.select({ articleId: nagiNewsScreening.articleId }).from(nagiNewsScreening).where(and(gt(nagiNewsScreening.expiresAt, now), eq(nagiNewsScreening.decision, "rejected_final")));
    const excluded = new Set([...existing.map((row) => row.articleId), ...recentRejected.map((row) => row.articleId)]);
    const slotQuota = Math.min(MAX_PER_SLOT, remaining);
    const publishedUrls = new Set(existing.map((row) => row.normalizedUrl));
    const fresh = (items: PositiveNewsCandidate[]) =>
      items.filter((item) => {
        const url = normalizedUrl(item.link);
        return url && !publishedUrls.has(url) && !excluded.has(item.articleId);
      });

    // まず在庫から。ここは NewsData のクレジットを使わない。
    const stocked = fresh(await takeStock(slotQuota, excluded, now));
    // 足りないぶんだけ NewsData を叩く。在庫で埋まったならクレジットは1つも使わない。
    const shortfall = slotQuota - stocked.length;
    let fetched: PositiveNewsCandidate[] = [];
    let usedTopic: string | undefined;
    if (shortfall > 0 && remainingCredits > 0) {
      const passed: PositiveNewsCandidate[] = [];
      // ページ数の上限は従来どおり3。ジャンル指定はその内側で最大2ページを使い、
      // クレジットの総量は増やさない。
      let budget = Math.min(3, remainingCredits);

      // まず関心ジャンル。bot_memory が覚えた固有名を広いジャンルへ一般化したもの
      // （NewsInterestWorker が作る）。ジャンルが無ければこの節は丸ごと飛び、
      // 従来どおりの無指定取得だけになる。
      const picked = budget >= TOPIC_PAGES
        ? await pickNewsInterestTopic({ now, cooldownMs: TOPIC_COOLDOWN_MS })
        : undefined;
      // ジャンル名がそのまま検索語。一覧に無い語（辞書を削ったあとに残った古い行など）は使わない。
      if (picked && isNewsInterestGenre(picked.topic)) {
        usedTopic = picked.topic;
        const result = await getPositiveNewsCandidates({ excludeArticleIds: excluded, maxPages: TOPIC_PAGES, topicQuery: picked.topic });
        creditsUsed += result.diagnostics.creditsUsed;
        budget -= result.diagnostics.creditsUsed;
        const accepted = acceptedArticles(result);
        passed.push(...accepted);
        await recordNewsInterestTopicYield(picked.topic, accepted.length);
      }

      // 残りは無指定取得。ジャンルがその日空振りでも、ニュースの供給は切らさない。
      if (budget > 0) {
        const result = await getPositiveNewsCandidates({ excludeArticleIds: excluded, maxPages: budget });
        creditsUsed += result.diagnostics.creditsUsed;
        passed.push(...acceptedArticles(result));
      }

      const seen = new Set<string>();
      fetched = fresh(passed).filter((item) =>
        seen.has(item.articleId) ? false : (seen.add(item.articleId), true),
      );
      // 今回の枠に入らないぶんを在庫へ。取得済みなので追加コストはゼロ。
      await stockCandidates(fetched.slice(shortfall), now);
    }
    const candidates = [...stocked, ...fetched.slice(0, shortfall)];
    if (!candidates.length) {
      await db.update(nagiNewsUpdateRuns).set({ status: "complete", newsDataCredits: sql`${nagiNewsUpdateRuns.newsDataCredits} + ${creditsUsed}`, finishedAt: new Date() }).where(eq(nagiNewsUpdateRuns.slot, slot));
      return 0;
    }
    // 全候補を必ず1回のGeminiリクエストで審査する。
    const decisions = await judgePositiveNewsBatch(candidates);
    let published = 0;
    for (const decision of decisions) {
      const candidate = candidates.find((item) => item.articleId === decision.articleId)!;
      const cacheKey = createHash("sha256").update(`${POSITIVE_NEWS_PROMPT_VERSION}:${candidate.articleId}:${candidate.title}:${candidate.description ?? ""}`).digest("hex");
      await db.insert(nagiNewsScreening).values({ cacheKey, articleId: candidate.articleId, decision: decision.publishable ? "approved_final" : "rejected_final", reasonCode: decision.reasonCode, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }).onConflictDoUpdate({ target: nagiNewsScreening.cacheKey, set: { decision: decision.publishable ? "approved_final" : "rejected_final", reasonCode: decision.reasonCode, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } });
      if (!decision.publishable || !candidate.link || !normalizedUrl(candidate.link)) continue;
      try {
        // NewsData が image_url を返さない記事は、ここで記事ページの OGP を見て補う。
        const imageUrl = await resolveNewsImageUrl(candidate);
        const ref = await publishNews({ articleId: candidate.articleId, url: candidate.link, titleJa: candidate.title, sourceName: candidate.sourceName, sourceUrl: candidate.sourceUrl, publishedAt: candidate.publishedAt, langs: ["ja"], createdAt: now.toISOString() });
        const snapshot = { snapshotArticleId: candidate.articleId, snapshotUrl: candidate.link, snapshotTitleJa: candidate.title,
          snapshotSourceName: candidate.sourceName ?? null, snapshotSourceUrl: candidate.sourceUrl ?? null,
          snapshotImageUrl: imageUrl ?? null,
          snapshotPublishedAt: candidate.publishedAt ? new Date(candidate.publishedAt) : null, snapshotCreatedAt: now };
        // 再公開時に hiddenAt は戻さない。戻すと管理者が隠した記事が黙って復活する。
        await db.insert(nagiNewsApprovals).values({ newsUri: ref.uri, newsCid: ref.cid, status: "approved", reasonCode: decision.reasonCode, botCommentJa: decision.botCommentJa, titleEn: decision.titleEn, botCommentEn: decision.botCommentEn, model: positiveNewsModel(), promptVersion: POSITIVE_NEWS_PROMPT_VERSION, ...snapshot }).onConflictDoUpdate({ target: [nagiNewsApprovals.newsUri, nagiNewsApprovals.newsCid], set: { status: "approved", reasonCode: decision.reasonCode, botCommentJa: decision.botCommentJa, titleEn: decision.titleEn, botCommentEn: decision.botCommentEn, model: positiveNewsModel(), promptVersion: POSITIVE_NEWS_PROMPT_VERSION, ...snapshot } });
        published++;
        // 在庫経由だった記事は消化済みにする（在庫から出続けないように）。
        await db.update(nagiNewsCandidates).set({ promotedNewsUri: ref.uri })
          .where(eq(nagiNewsCandidates.articleId, candidate.articleId));
      } catch (error) {
        console.error(`[ERROR][NEWS_FEED] Failed to publish article=${candidate.articleId}`, error);
      }
    }
    await db.delete(nagiNewsScreening).where(lt(nagiNewsScreening.expiresAt, now));
    // gate が落とした記事は在庫に置いておかない（次のスロットで拾い直しても同じ結論になる）。
    const rejectedIds = decisions.filter((d) => !d.publishable).map((d) => d.articleId);
    if (rejectedIds.length)
      await db.delete(nagiNewsCandidates).where(inArray(nagiNewsCandidates.articleId, rejectedIds));
    await db.delete(nagiNewsCandidates).where(lt(nagiNewsCandidates.expiresAt, now));
    await db.update(nagiNewsUpdateRuns).set({ status: "complete", publishedCount: published, newsDataCredits: sql`${nagiNewsUpdateRuns.newsDataCredits} + ${creditsUsed}`, finishedAt: new Date() }).where(eq(nagiNewsUpdateRuns.slot, slot));
    const stockLeft = await db.select({ n: sql<number>`count(*)::int` }).from(nagiNewsCandidates)
      .where(and(isNull(nagiNewsCandidates.promotedNewsUri), gt(nagiNewsCandidates.expiresAt, now)));
    console.log(`[INFO][NEWS_FEED] slot=${slot.toISOString()} published=${published} fromStock=${stocked.length} credits=${creditsUsed} topic=${usedTopic ?? "-"} stockLeft=${stockLeft[0]?.n ?? 0}`);
    // 記事ページはビルド時にプリレンダされるので、公開しただけでは検索に出ない。
    // 1日最大4回しか走らないので、Vercel のデプロイ上限には十分収まる。
    if (published > 0) await requestClientRebuild(`news slot=${slot.toISOString()}`);
    return published;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(nagiNewsUpdateRuns).set({ status: "failed", newsDataCredits: sql`${nagiNewsUpdateRuns.newsDataCredits} + ${creditsUsed}`, lastError: message.slice(0, 2000), finishedAt: new Date() }).where(eq(nagiNewsUpdateRuns.slot, slot));
    console.error(`[ERROR][NEWS_FEED] slot=${slot.toISOString()}`, error);
    return 0;
  }
}

export function schedulePositiveNewsUpdates() {
  const timer = startWorkerLoop({
    name: "NEWS_FEED",
    intervalMs: 30 * 60 * 1000,
    tick: updatePositiveNews,
    immediate: true,
  });
  timer.unref();
  return timer;
}
