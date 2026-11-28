import { bytes, LinkMetadataError } from "@bsky-affirmative-bot/nagi-linkcard";
import type { BluemojiFormats } from "@bsky-affirmative-bot/nagi-lexicon";
import { BLUEMOJI_ORIGINAL_MAX_BYTES } from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";

export async function readEmojiBlob(
  response: Response,
  asset: BluemojiFormats["asset"],
): Promise<Uint8Array> {
  const maxBytes = Math.min(
    asset.maxBytes ?? BLUEMOJI_ORIGINAL_MAX_BYTES,
    BLUEMOJI_ORIGINAL_MAX_BYTES,
  );
  const body = await bytes(response, maxBytes).catch((error) => {
    if (error instanceof LinkMetadataError && error.code === "response_too_large") {
      throw new ApiError(502, "upstream_unavailable", "Emoji blob exceeds its size limit");
    }
    throw error;
  });
  if (
    asset.mediaType === "application/lottie+zip" &&
    (body[0] !== 0x50 || body[1] !== 0x4b || body[2] !== 0x03 || body[3] !== 0x04)
  ) {
    throw new ApiError(502, "upstream_unavailable", "Emoji blob is not a Lottie ZIP");
  }
  return body;
}
