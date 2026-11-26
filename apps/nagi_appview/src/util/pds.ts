import {
  DidWebResolver,
  DOC_PATH,
  IdResolver,
  UnsupportedDidWebPathError,
} from "@atproto/identity";
import { PublicUrlError, safeFetch } from "@bsky-affirmative-bot/shared-configs/ssrf";
import { ApiError } from "../middleware/errors.js";
import { safeUrl } from "./ssrf.js";

class PublicDidWebResolver extends DidWebResolver {
  override async resolveNoCheck(did: string): Promise<unknown> {
    const parts = did.slice("did:web:".length).split(":");
    if (parts.length !== 1) throw new UnsupportedDidWebPathError(did);
    const authority = decodeURIComponent(parts[0]);
    if (!/^[a-zA-Z0-9._-]+(?::[0-9]+)?$/.test(authority))
      throw new ApiError(400, "invalid_request", "Invalid did:web authority");

    try {
      const response = await safeFetch(`https://${authority}${DOC_PATH}`, {
        headers: { accept: "application/did+ld+json,application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return response.json();
    } catch (error) {
      if (error instanceof PublicUrlError)
        throw new ApiError(400, "invalid_request", error.message);
      throw error;
    }
  }
}

const resolver = new IdResolver();
resolver.did.methods.set("web", new PublicDidWebResolver(3_000));
export const DID = /^did:(plc:[a-z2-7]+|web:[a-zA-Z0-9.:%_-]+)$/;

/** DID ドキュメントから PDS のベース URL を解決する。 */
export async function resolvePdsUrl(did: string): Promise<URL> {
  if (!DID.test(did))
    throw new ApiError(400, "invalid_request", "Invalid DID");
  const doc = await resolver.did.resolve(did);
  const pds = doc?.service?.find((s) => s.id === "#atproto_pds")
    ?.serviceEndpoint;
  if (typeof pds !== "string" || !pds.startsWith("https://"))
    throw new ApiError(404, "not_found", "PDS not found");
  return safeUrl(pds);
}
