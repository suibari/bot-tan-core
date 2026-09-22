import {
  isNagiStandardSitePublication,
  nagiPostFromStandardDocument,
  nagiStandardSitePublicationUri,
  STANDARD_SITE_DOCUMENT,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { resolvePdsUrl } from "../util/pds.js";

export const STANDARD_DOCUMENT = STANDARD_SITE_DOCUMENT;

/** Nagi の記事を既存の表示・モデレーション用の形へ射影する。PDS の正本は document。 */
export function standardDocumentPost(value: any): any | undefined {
  return nagiPostFromStandardDocument(value);
}

type PublicationLoader = (
  did: string,
  publicationUri: string,
) => Promise<unknown>;

const publicationCache = new Map<
  string,
  { expiresAt: number; value: boolean }
>();
const PUBLICATION_CACHE_MS = 5 * 60_000;
const PUBLICATION_CACHE_MAX = 1_000;

const loadPublication: PublicationLoader = async (did, publicationUri) => {
  const rkey = publicationUri.slice(publicationUri.lastIndexOf("/") + 1);
  const endpoint = await resolvePdsUrl(did);
  endpoint.pathname = "/xrpc/com.atproto.repo.getRecord";
  endpoint.search = new URLSearchParams({
    repo: did,
    collection: "site.standard.publication",
    rkey,
  }).toString();
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Failed to read standard.site publication: ${response.status}`);
  const data = (await response.json()) as { value?: unknown };
  return data.value;
};

/** document.site の参照先 publication が Nagi の canonical URL を持つか確認する。 */
export async function isNagiStandardDocument(
  did: string,
  rkey: string,
  value: any,
  loader: PublicationLoader = loadPublication,
): Promise<boolean> {
  const publicationUri = nagiStandardSitePublicationUri(value, did, rkey);
  if (!publicationUri) return false;
  if (loader === loadPublication) {
    const cached = publicationCache.get(publicationUri);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const publication = await loader(did, publicationUri);
  const matches = isNagiStandardSitePublication(publication);
  // publication 作成直後の一時的な404はキャッシュせず、reconcileで再確認できるようにする。
  if (loader === loadPublication && publication !== undefined) {
    if (publicationCache.size >= PUBLICATION_CACHE_MAX) {
      const oldest = publicationCache.keys().next().value;
      if (oldest) publicationCache.delete(oldest);
    }
    publicationCache.set(publicationUri, {
      expiresAt: Date.now() + PUBLICATION_CACHE_MS,
      value: matches,
    });
  }
  return matches;
}
