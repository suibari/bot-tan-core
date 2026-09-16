import { getNewsMetadata, type LinkMetadata } from "@bsky-affirmative-bot/nagi-linkcard";
import type { PositiveNewsCandidate } from "@bsky-affirmative-bot/bot-brain";

/**
 * 一覧が表示に使えるURLだけを通す。画像データ自体は保存せず、クライアントが
 * 配信元から直接読むので、混在コンテンツにならない https に限る。
 */
export function httpsImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 掲載直前に画像URLを確定する。
 *
 * NewsData の `image_url` は**返ってこない記事が多い**うえ、在庫（news_candidates）にも
 * 列を足す前に積まれた行は画像URLを持たない。取り込み時の値だけに頼ると、その記事は
 * 二度と画像が埋まらない（バックフィルを回すまで一覧が画像なしのまま残る）。
 * ここで一度だけ記事ページの OGP を見て補う。
 *
 * 取得に失敗しても掲載は止めない。画像はニュースの付加情報であって、記事が出ない方が
 * 損失が大きい。SSRF 対策は `getNewsMetadata` の `limitedFetch` に集約済みなので、
 * ここで自前の fetch を書かないこと。
 */
export async function resolveNewsImageUrl(
  candidate: Pick<PositiveNewsCandidate, "articleId" | "imageUrl" | "link">,
  deps: {
    fetchMetadata?: (url: string) => Promise<LinkMetadata>;
    logger?: Pick<Console, "warn">;
  } = {},
): Promise<string | undefined> {
  const known = httpsImageUrl(candidate.imageUrl);
  if (known) return known;
  if (!candidate.link) return undefined;
  const fetchMetadata = deps.fetchMetadata ?? getNewsMetadata;
  try {
    const metadata = await fetchMetadata(candidate.link);
    return httpsImageUrl(metadata.image);
  } catch (error) {
    (deps.logger ?? console).warn(
      `[WARN][NEWS_FEED] OGP画像を取得できませんでした article=${candidate.articleId}:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
