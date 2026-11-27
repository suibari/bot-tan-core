import {
  assertPublicHost as assertSharedPublicHost,
  assertPublicUrl,
  PublicUrlError,
} from "@bsky-affirmative-bot/shared-configs/ssrf";
import { LinkMetadataError } from "./errors.js";

export { isBlockedAddress as blockedAddress } from "@bsky-affirmative-bot/shared-configs/ssrf";

export async function withPublicUrlError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PublicUrlError)
      throw new LinkMetadataError(400, "invalid_request", error.message);
    throw error;
  }
}

export const assertPublicHost = (hostname: string) =>
  withPublicUrlError(() => assertSharedPublicHost(hostname));

export const safeUrl = (raw: string, base?: URL) =>
  withPublicUrlError(() => assertPublicUrl(raw, base));
