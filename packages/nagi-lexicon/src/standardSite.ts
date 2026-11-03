import { NAGI, STANDARD_SITE_DOCUMENT } from "./constants.js";
export const NAGI_STANDARD_SITE_URL = "https://nagi.suibari.com";

/**
 * ユーザーごとの publication.url。standard.site の検証（`/.well-known/site.standard.publication`
 * にパスを足したもの）で各自の publication を答えられるよう、Nagi は /blog/<did> を使う。
 */
export const nagiStandardSitePublicationUrl = (did: string) =>
  `${NAGI_STANDARD_SITE_URL}/blog/${did}`;

/**
 * publication の URL が Nagi のものか。末尾 slash だけ正規化する。
 * 移行前の共通 origin と、did を渡したときはその DID 用の /blog/<did> を認める。
 */
export function isNagiStandardSitePublication(value: any, did?: string): boolean {
  if (value?.$type !== "site.standard.publication" || typeof value.url !== "string")
    return false;
  const url = value.url.replace(/\/+$/, "");
  return (
    url === NAGI_STANDARD_SITE_URL ||
    (did !== undefined && url === nagiStandardSitePublicationUrl(did))
  );
}

/**
 * document.path が Nagi の記事の形か。移行前は origin からの /blog/<did>/<rkey>、
 * 今は publication.url（/blog/<did>）からの /<rkey>。どちらも canonical は同じ URL。
 */
const nagiDocumentPath = (path: unknown, did: string, rkey: string) =>
  path === `/blog/${did}/${rkey}` || path === `/${rkey}`;

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
    !/^(?:\/blog\/did:[^/]+)?\/[^/]+$/.test(value.path) ||
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

  // Nagi の原文（facet の位置の基準）は nagi.text。content は他のリーダー向けに書き出した
  // GFM なので、原文が無い移行前の記事だけ content を原文として読む。
  if (extension?.text !== undefined && typeof extension.text !== "string") return undefined;
  return {
    $type: NAGI.post,
    text: extension?.text ?? value.content.text.markdown,
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
    !nagiDocumentPath(value.path, did, rkey) ||
    typeof value.site !== "string" ||
    !value.site.startsWith(`at://${did}/site.standard.publication/`)
  )
    return undefined;
  return value.site;
}
