import { db, nagiPosts } from "@bsky-affirmative-bot/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import {
  createVideoFallback,
  VideoUnavailableError,
} from "../services/videoFallback.js";
import { DID, resolvePdsUrl } from "../util/pds.js";

const CID = /^[a-zA-Z0-9]+$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** 取り込んだ投稿が参照している動画だけを作る。任意の blob を取りに行かせない。 */
async function postExists(did: string, cid: string) {
  const rows = await db
    .select({ uri: nagiPosts.uri })
    .from(nagiPosts)
    .where(
      and(
        eq(nagiPosts.did, did),
        isNull(nagiPosts.deletedAt),
        sql`${nagiPosts.embedVideo} #>> '{video,ref,$link}' = ${cid}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const videos = createVideoFallback({
  cacheDir: config.videoCacheDir,
  postExists,
  resolvePdsUrl,
});

export const getVideo: RequestHandler = async (req, res, next) => {
  try {
    const { did, cid, file } = req.params as Record<string, string>;
    if (!DID.test(did) || !CID.test(cid))
      throw new ApiError(400, "invalid_request", "Invalid DID or CID");
    const source = await videos.resolve(did, cid, file);
    if (source.kind === "upstream") {
      // 消えたら手元の HLS へ切り替えるので、リダイレクトは短くしか覚えさせない。
      res.set("Cache-Control", "public, max-age=600");
      return res.redirect(302, source.url);
    }
    res.set("Cache-Control", IMMUTABLE);
    if (file.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl");
    else if (file.endsWith(".m4s")) res.type("video/iso.segment");
    res.sendFile(source.path, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (e) {
    if (e instanceof VideoUnavailableError) {
      if (e.status === 502) console.warn("[WARN][NAGI_VIDEO]", e.message);
      return next(new ApiError(e.status, e.status === 404 ? "not_found" : "upstream_unavailable", "Video unavailable"));
    }
    next(e);
  }
};
