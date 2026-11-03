import type { RequestHandler } from "express";
import { nagiStandardSitePublicationUrl } from "@bsky-affirmative-bot/nagi-lexicon";
import { ApiError } from "../middleware/errors.js";
import { DID, resolvePdsUrl } from "../util/pds.js";

/**
 * standard.site の publication 検証。Nagi の publication.url は
 * `https://nagi.suibari.com/blog/<did>` なので、検証側は
 * `https://nagi.suibari.com/.well-known/site.standard.publication/blog/<did>` を引く。
 * フロント（Vercel）はそのパスをここへ rewrite する。
 *
 * 答えるのは url がちょうどこの DID 用のものになっている publication だけ。移行前の
 * 共通 url のものを返しても、検証側の照合（url と AT-URI の一致）は通らない。
 */
const cache = new Map<string, { expiresAt: number; uri: string | null }>();
const FOUND_MS = 5 * 60_000;
const MISSING_MS = 60_000;
const CACHE_MAX = 1_000;
const MAX_PAGES = 5;

async function findPublication(did: string): Promise<string | null> {
  const expected = nagiStandardSitePublicationUrl(did);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const endpoint = await resolvePdsUrl(did);
    endpoint.pathname = "/xrpc/com.atproto.repo.listRecords";
    endpoint.search = new URLSearchParams({
      repo: did,
      collection: "site.standard.publication",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    }).toString();
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new ApiError(502, "upstream_unavailable", "Repository unavailable");
    const data = (await response.json()) as {
      records?: Array<{ uri?: unknown; value?: { url?: unknown } }>;
      cursor?: unknown;
    };
    for (const record of data.records ?? []) {
      const url = record.value?.url;
      if (
        typeof record.uri === "string" &&
        record.uri.startsWith(`at://${did}/site.standard.publication/`) &&
        typeof url === "string" &&
        url.replace(/\/+$/, "") === expected
      )
        return record.uri;
    }
    cursor = typeof data.cursor === "string" ? data.cursor : undefined;
    if (!cursor) break;
  }
  return null;
}

export const getStandardSitePublication: RequestHandler = async (req, res, next) => {
  try {
    const did = req.params.did;
    if (!DID.test(did)) throw new ApiError(400, "invalid_request", "Invalid DID");
    let entry = cache.get(did);
    if (!entry || entry.expiresAt <= Date.now()) {
      const uri = await findPublication(did);
      entry = { uri, expiresAt: Date.now() + (uri ? FOUND_MS : MISSING_MS) };
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(did, entry);
    }
    if (!entry.uri) throw new ApiError(404, "not_found", "Publication not found");
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
    res.send(entry.uri);
  } catch (e) {
    next(e);
  }
};
