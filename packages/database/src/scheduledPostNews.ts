/**
 * 気まぐれ定期ポストで紹介する Nagi のニュースを1件選ぶ。
 *
 * 選ぶのは **botたん自身が掲載したニュース**（positiveNewsUpdater が審査を通して出したもの）
 * だけ。利用者が投稿したニュースは承認後も本人が編集できるので、定期ポストの材料にはしない。
 *
 * 公開条件は AppView の approvedNewsConditions と揃える（削除・非表示・承認取り消し・
 * CID のずれを落とす）。成人向けラベルが付いた記事と、まだ判定していない記事も出さない。
 * 定期ポストは Bluesky にも出るので、未成年の閲覧者に見せない記事を選ぶ理由が無い。
 */
import { and, desc, eq, gt, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "./db.js";
import { nagiNews, nagiNewsApprovals } from "./nagiSchema.js";

/** 紹介してよい記事の鮮度。一覧に並んでいるうちに紹介する（在庫の TTL と同じ3日）。 */
export const SCHEDULED_POST_NEWS_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** AppView の ADULT_LABELS と同じ。未成年に返さない記事は定期ポストにも出さない。 */
const ADULT_LABELS = ["sexual", "nudity", "graphic-media", "!hide"];

export interface ScheduledPostNews {
  uri: string;
  cid: string;
  rkey: string;
  articleId: string;
  titleJa: string;
  titleEn?: string;
  /** 審査時に botたんが書いた紹介文（最後が読者への問いかけ）。 */
  commentJa: string;
  commentEn?: string;
  sourceName?: string;
  /** 記事の OGP 画像。無い記事もある。 */
  imageUrl?: string;
}

/**
 * 話しやすさ（talk_score）の高い順、同点なら新しい順に1件。
 * `excludeArticleIds` は最近の定期ポストで紹介済みの記事。
 */
export async function pickNagiNewsForScheduledPost(params: {
  botDid: string;
  excludeArticleIds?: string[];
  now?: Date;
}): Promise<ScheduledPostNews | undefined> {
  const now = params.now ?? new Date();
  const excluded = (params.excludeArticleIds ?? []).filter(Boolean);
  const createdAt = sql`coalesce(${nagiNewsApprovals.snapshotCreatedAt}, ${nagiNews.recordCreatedAt})`;
  const [row] = await db
    .select({ news: nagiNews, approval: nagiNewsApprovals })
    .from(nagiNews)
    .innerJoin(
      nagiNewsApprovals,
      and(eq(nagiNewsApprovals.newsUri, nagiNews.uri), eq(nagiNewsApprovals.newsCid, nagiNews.cid)),
    )
    .where(
      and(
        eq(nagiNews.did, params.botDid),
        isNull(nagiNews.deletedAt),
        eq(nagiNewsApprovals.status, "approved"),
        isNull(nagiNewsApprovals.hiddenAt),
        isNotNull(nagiNewsApprovals.botCommentJa),
        isNotNull(nagiNews.moderationVersion),
        sql`not (${nagiNews.moderationLabels} && ${sql.raw(`array[${ADULT_LABELS.map((label) => `'${label}'`).join(",")}]::text[]`)})`,
        // 型付き演算子で比べる（AGENTS.md: sql テンプレートへ Date を直に入れない）。
        gt(nagiNews.recordCreatedAt, new Date(now.getTime() - SCHEDULED_POST_NEWS_MAX_AGE_MS)),
        excluded.length ? notInArray(nagiNews.articleId, excluded) : undefined,
      ),
    )
    .orderBy(sql`${nagiNewsApprovals.talkScore} desc nulls last`, desc(createdAt))
    .limit(1);
  if (!row) return undefined;

  const commentJa = row.approval.botCommentJa?.trim();
  if (!commentJa) return undefined;
  const titleEn = row.approval.titleEn?.trim();
  const commentEn = row.approval.botCommentEn?.trim();
  const sourceName = (row.approval.snapshotSourceName ?? row.news.sourceName)?.trim();
  const imageUrl = row.approval.snapshotImageUrl?.trim();
  return {
    uri: row.news.uri,
    cid: row.news.cid,
    rkey: row.news.rkey,
    articleId: row.news.articleId,
    titleJa: (row.approval.snapshotTitleJa ?? row.news.titleJa).trim(),
    commentJa,
    ...(titleEn ? { titleEn } : {}),
    ...(commentEn ? { commentEn } : {}),
    ...(sourceName ? { sourceName } : {}),
    ...(imageUrl && /^https:\/\//i.test(imageUrl) ? { imageUrl } : {}),
  };
}

/** Nagi のニュースページ。Bluesky のリンクカードの行き先。 */
export function nagiNewsPageUrl(rkey: string): string {
  return `https://nagi.suibari.com/news/${encodeURIComponent(rkey)}`;
}
