import { safeFetch } from "@bsky-affirmative-bot/shared-configs/ssrf";
import { db, nagiEmojis } from "@bsky-affirmative-bot/database";
import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import { isNormalizedBluemojiFormats } from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";
import { DID, resolvePdsUrl } from "../util/pds.js";
import { emojiAssetHeaders } from "../util/emojiAssetHeaders.js";
import { resolveEmojiAsset } from "../services/emoji.js";

const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
const CID = /^[A-Za-z0-9]+$/;

type HeaderResponse = {
  removeHeader(name: string): void;
  set(headers: Record<string, string>): unknown;
};

const setSuccessHeaders = (
  res: HeaderResponse,
  mediaType: string,
  contentLength?: number,
) => {
  // Origin依存・リクエスト時点依存のヘッダーをCDNへ保存しない。
  for (const name of ["Vary", "RateLimit", "RateLimit-Policy"]) {
    res.removeHeader(name);
  }
  res.set(emojiAssetHeaders(mediaType, contentLength));
};

/** formats_v0 の bytes は PDS blob ではないため、検証済みDB行から配信する。 */
export const getEmojiAsset: RequestHandler = async (req, res, next) => {
  try {
    const { did, rkey, cid } = req.params;
    if (!DID.test(did) || !RKEY.test(rkey) || !CID.test(cid))
      throw new ApiError(400, "invalid_request", "Invalid emoji asset");
    const uri = `at://${did}/blue.moji.collection.item/${rkey}`;
    let [row] = await db
      .select({ formats: nagiEmojis.formats })
      .from(nagiEmojis)
      .where(and(eq(nagiEmojis.uri, uri), eq(nagiEmojis.cid, cid)))
      .limit(1);
    if (!row) {
      const formats = await resolveEmojiAsset(uri, cid);
      if (formats) row = { formats };
    }
    if (!row || !isNormalizedBluemojiFormats(row.formats))
      throw new ApiError(404, "not_found", "Emoji asset not found");
    const { asset } = row.formats;
    if (asset.kind === "blob") {
      const url = await resolvePdsUrl(did);
      url.pathname = "/xrpc/com.atproto.sync.getBlob";
      url.searchParams.set("did", did);
      url.searchParams.set("cid", asset.value);
      const upstream = await safeFetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new ApiError(
          upstream.status === 404 ? 404 : 502,
          "upstream_unavailable",
          "Emoji asset unavailable",
        );
      }
      setSuccessHeaders(res, asset.mediaType);
      await upstream.body.pipeTo(
        new WritableStream({
          write(chunk) {
            res.write(Buffer.from(chunk));
          },
          close() {
            res.end();
          },
          abort() {
            res.end();
          },
        }),
      );
      return;
    }
    const bytes = Buffer.from(asset.value, "base64");
    setSuccessHeaders(res, asset.mediaType, bytes.byteLength);
    res.end(bytes);
  } catch (error) {
    next(error);
  }
};
