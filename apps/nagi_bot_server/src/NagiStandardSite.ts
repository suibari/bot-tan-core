import { resolvePdsUrl } from "@bsky-affirmative-bot/bot-runtime";
import {
  isNagiStandardSitePublication,
  nagiStandardSitePublicationUri,
} from "@bsky-affirmative-bot/nagi-lexicon";

type PublicationLoader = (
  did: string,
  publicationUri: string,
) => Promise<unknown>;

const cache = new Map<string, { expiresAt: number; value: boolean }>();
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 1_000;

const loadPublication: PublicationLoader = async (did, publicationUri) => {
  const pds = await resolvePdsUrl(did);
  const endpoint = new URL("/xrpc/com.atproto.repo.getRecord", pds);
  endpoint.search = new URLSearchParams({
    repo: did,
    collection: "site.standard.publication",
    rkey: publicationUri.slice(publicationUri.lastIndexOf("/") + 1),
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

export async function isNagiStandardDocument(
  did: string,
  rkey: string,
  value: unknown,
  loader: PublicationLoader = loadPublication,
): Promise<boolean> {
  const publicationUri = nagiStandardSitePublicationUri(value, did, rkey);
  if (!publicationUri) return false;
  if (loader === loadPublication) {
    const cached = cache.get(publicationUri);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const publication = await loader(did, publicationUri);
  const matches = isNagiStandardSitePublication(publication);
  // publication 作成直後の一時的な404はキャッシュせず、次のイベントで再確認する。
  if (loader === loadPublication && publication !== undefined) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(publicationUri, {
      expiresAt: Date.now() + CACHE_MS,
      value: matches,
    });
  }
  return matches;
}
