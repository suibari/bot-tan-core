import express from "express";
import {
  SCHEDULED_POST_BODY_LIMIT_BYTES,
  type ScheduledPostRequest,
} from "@bsky-affirmative-bot/clients";
import { publishScheduledPost } from "./ScheduledPostFeature.js";

export const router = express.Router();

/** monologue（ひとりごと）は Nagi 専用なので、ここでは受け付けない。 */
const BSKY_SCHEDULED_KINDS: ReadonlySet<string> = new Set(["morning", "whimsical", "good-night"]);

router.post(
  "/posts/scheduled",
  express.json({ limit: SCHEDULED_POST_BODY_LIMIT_BYTES }),
  async (req, res) => {
    try {
      const request = req.body as ScheduledPostRequest;
      if (!BSKY_SCHEDULED_KINDS.has(request?.kind) || typeof request.text !== "string" || !request.text.trim()) {
        res.status(400).json({ error: "kind and text are required" });
        return;
      }
      res.status(200).json(await publishScheduledPost(request));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);
