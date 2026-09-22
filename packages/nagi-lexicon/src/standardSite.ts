import { NAGI, STANDARD_SITE_DOCUMENT } from "./constants.js";
export const NAGI_STANDARD_SITE_URL = "https://nagi.suibari.com";

/** publication の URL が Nagi の canonical origin か。末尾 slash だけ正規化する。 */
export function isNagiStandardSitePublication(value: any): boolean {
  return (
    value?.$type === "site.standard.publication" &&
    typeof value.url === "string" &&
    value.url.replace(/\/+$/, "") === NAGI_STANDARD_SITE_URL
  );
}

/**
 * standard.site の Nagi 記事を、表示・モデレーション・bot 応答で使う Nagi 投稿形へ射影する。
 * PDS 上の正本と URI は site.standard.document のまま維持する。
 */
export function nagiPostFromStandardDocument(value: any): any | undefined {
  if (
    !value ||
    value.$type !== STANDARD_SITE_DOCUMENT ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    typeof value.site !== "string" ||
    !/^at:\/\/did:[^/]+\/site\.standard\.publication\/[^/]+$/.test(
      value.site,
    ) ||
    typeof value.path !== "string" ||
    !/^\/blog\/did:[^/]+\/[^/]+$/.test(value.path) ||
    value.content?.$type !== "at.markpub.markdown" ||
    value.content?.text?.$type !== "at.markpub.text" ||
    typeof value.content.text.markdown !== "string"
  )
    return undefined;

  const extension = value.nagi;
  if (
    extension !== undefined &&
    (!extension || typeof extension !== "object" || Array.isArray(extension))
  )
    return undefined;

  return {
    $type: NAGI.post,
    text: value.content.text.markdown,
    createdAt: value.publishedAt,
    article: true,
    facets: extension?.facets,
    langs: extension?.langs,
    tags: value.tags,
    labels: value.labels,
    botSilent: extension?.botSilent,
    embed:
      extension?.embed ??
      (value.coverImage
        ? {
            $type: `${NAGI.post}#images`,
            images: [{ image: value.coverImage, alt: value.title }],
          }
        : undefined),
    linkCards: extension?.linkCards,
  };
}

/** document 自体から検証できる、Nagi publication の参照先。 */
export function nagiStandardSitePublicationUri(
  value: any,
  did: string,
  rkey: string,
): string | undefined {
  if (
    !nagiPostFromStandardDocument(value) ||
    value.path !== `/blog/${did}/${rkey}` ||
    typeof value.site !== "string" ||
    !value.site.startsWith(`at://${did}/site.standard.publication/`)
  )
    return undefined;
  return value.site;
}
