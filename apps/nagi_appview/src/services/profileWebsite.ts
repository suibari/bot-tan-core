import { db, nagiActors } from "@bsky-affirmative-bot/database";
import { getLinkMetadata, safeUrl } from "@bsky-affirmative-bot/nagi-linkcard";
import { eq } from "drizzle-orm";

type WebsiteCard = {
  uri: string;
  title: string;
  description?: string;
  thumb?: string;
};

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 500;
const RECORD_LIMIT = 64_000;
const cache = new Map<
  string,
  { expiresAt: number; value: Promise<WebsiteCard | undefined> }
>();

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > RECORD_LIMIT) throw new Error("Profile record is too large");
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > RECORD_LIMIT) {
      await reader.cancel();
      throw new Error("Profile record is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchWebsiteCard(did: string): Promise<WebsiteCard | undefined> {
  const [actor] = await db
    .select({ pdsUrl: nagiActors.pdsUrl })
    .from(nagiActors)
    .where(eq(nagiActors.did, did))
    .limit(1);
  if (!actor) return undefined;

  const pds = await safeUrl(actor.pdsUrl);
  const endpoint = new URL("/xrpc/com.atproto.repo.getRecord", pds);
  endpoint.search = new URLSearchParams({
    repo: did,
    collection: "com.suibari.nagi.profile",
    rkey: "self",
  }).toString();
  const response = await fetch(endpoint, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Profile record fetch failed (${response.status})`);
  const body = (await readJson(response)) as { value?: { website?: unknown } };
  if (typeof body.value?.website !== "string") return undefined;

  const website = await safeUrl(body.value.website);
  const metadata = await getLinkMetadata(website.href);
  return {
    uri: metadata.uri,
    title: metadata.title,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.image ? { thumb: metadata.image } : {}),
  };
}

/**
 * Nagi profile の website は補助表示なので、PDS/リンク先の失敗は空として返す。
 * 短時間のキャッシュと同時リクエスト共有で、プロフィール閲覧による外部負荷を抑える。
 */
export async function getProfileWebsiteCard(
  did: string,
): Promise<WebsiteCard | undefined> {
  const cached = cache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.delete(did);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  const value = fetchWebsiteCard(did).catch(() => undefined);
  cache.set(did, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}
