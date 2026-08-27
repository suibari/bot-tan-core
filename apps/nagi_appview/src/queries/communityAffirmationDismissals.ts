import {
  db,
  nagiCommunityAffirmationDismissals,
  nagiPosts,
} from "@bsky-affirmative-bot/database";
import { eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { COMMUNITY_AFFIRMATION_WINDOW_MS } from "./communityAffirmations.js";

const MAX_URIS = 200;
const MAX_URI_LENGTH = 2048;

export async function putCommunityAffirmationDismissals(
  viewerDid: string,
  input: unknown,
) {
  const raw = (input ?? {}) as { uris?: unknown };
  if (!Array.isArray(raw.uris) || raw.uris.length > MAX_URIS)
    throw new ApiError(
      400,
      "invalid_request",
      "uris must be an array of at most 200 items",
    );
  const uris = [...new Set(raw.uris)];
  if (
    uris.some(
      (uri) =>
        typeof uri !== "string" ||
        !uri.startsWith("at://") ||
        uri.length > MAX_URI_LENGTH,
    )
  )
    throw new ApiError(400, "invalid_request", "Invalid uri");
  if (!uris.length) return { accepted: 0 };
  const now = new Date();
  const rows = await db
    .select({ uri: nagiPosts.uri, createdAt: nagiPosts.recordCreatedAt })
    .from(nagiPosts)
    .where(inArray(nagiPosts.uri, uris as string[]));
  const values = rows.flatMap((row) => {
    const expiresAt = new Date(
      row.createdAt.getTime() + COMMUNITY_AFFIRMATION_WINDOW_MS,
    );
    return expiresAt > now
      ? [{ viewerDid, sourceUri: row.uri, dismissedAt: now, expiresAt }]
      : [];
  });
  if (values.length) {
    await db
      .insert(nagiCommunityAffirmationDismissals)
      .values(values)
      .onConflictDoUpdate({
        target: [
          nagiCommunityAffirmationDismissals.viewerDid,
          nagiCommunityAffirmationDismissals.sourceUri,
        ],
        set: {
          dismissedAt: sql`excluded.dismissed_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      });
  }
  return { accepted: uris.length };
}

export const communityAffirmationDismissalCleanupCondition = (now: Date) =>
  or(
    lt(nagiCommunityAffirmationDismissals.expiresAt, now),
    notExists(
      db
        .select({ uri: nagiPosts.uri })
        .from(nagiPosts)
        .where(eq(nagiPosts.uri, nagiCommunityAffirmationDismissals.sourceUri)),
    ),
  )!;

export async function cleanupCommunityAffirmationDismissals(now = new Date()) {
  await db
    .delete(nagiCommunityAffirmationDismissals)
    .where(communityAffirmationDismissalCleanupCondition(now));
}

export function startCommunityAffirmationDismissalCleanup() {
  void cleanupCommunityAffirmationDismissals().catch((error) =>
    console.error(
      "[ERROR][APPVIEW] Failed to clean community dismissals:",
      error,
    ),
  );
  const timer = setInterval(
    () => {
      void cleanupCommunityAffirmationDismissals().catch((error) =>
        console.error(
          "[ERROR][APPVIEW] Failed to clean community dismissals:",
          error,
        ),
      );
    },
    6 * 60 * 60 * 1_000,
  );
  timer.unref();
  return timer;
}
