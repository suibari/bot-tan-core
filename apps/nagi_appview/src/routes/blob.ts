import { safeFetch } from "@bsky-affirmative-bot/shared-configs/ssrf";
import type { RequestHandler } from "express";
import { ApiError } from "../middleware/errors.js";
import { DID, resolvePdsUrl } from "../util/pds.js";
const CID = /^[a-zA-Z0-9]+$/;
export const getBlob: RequestHandler = async (req, res, next) => {
  try {
    const { did, cid } = req.params;
    if (!DID.test(did) || !CID.test(cid))
      throw new ApiError(400, "invalid_request", "Invalid DID or CID");
    const url = await resolvePdsUrl(did);
    url.pathname = "/xrpc/com.atproto.sync.getBlob";
    url.searchParams.set("did", did);
    url.searchParams.set("cid", cid);
    const upstream = await safeFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      throw new ApiError(
        upstream.status === 404 ? 404 : 502,
        "upstream_unavailable",
        "Blob unavailable",
      );
    }
    const type = upstream.headers.get("content-type") ?? "";
    if (!type.startsWith("image/") && type !== "application/lottie+zip") {
      await upstream.body.cancel();
      throw new ApiError(415, "invalid_request", "Unsupported blob type");
    }
    res.set({
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    upstream.body
      .pipeTo(
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
      )
      .catch(next);
  } catch (e) {
    next(e);
  }
};
