import { db, nagiActors, nagiPosts, nagiProfiles } from "@bsky-affirmative-bot/database";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { ADULT_LABELS } from "../services/moderation/index.js";
import { decodeCursor, encodeCursor } from "./timeline.js";

// article はブログタブでの明示的な公開選択。削除・限定・判定待ち・成人向けは索引しない。
export async function listIndexableBlogs(opts: { limit: number; cursor?: string }) {
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  const adultLabels = sql`${sql.param([...ADULT_LABELS])}::text[]`;
  const rows = await db
    .select({
      uri: nagiPosts.uri,
      text: nagiPosts.text,
      indexedAt: nagiPosts.indexedAt,
      createdAt: nagiPosts.recordCreatedAt,
      did: nagiPosts.did,
      handle: nagiActors.handle,
      displayName: nagiProfiles.displayName,
    })
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiPosts.did))
    .where(and(
      sql`${nagiPosts.recordJson}->>'article' = 'true'`,
      sql`coalesce(${nagiPosts.recordJson}->>'cwRestricted', 'false') <> 'true'`,
      isNull(nagiPosts.deletedAt),
      isNull(nagiPosts.replyParentUri),
      isNull(nagiPosts.channelUri),
      isNull(nagiPosts.quoteUri),
      eq(nagiPosts.kossori, false),
      sql`${nagiPosts.moderationVersion} is not null`,
      sql`not (${nagiPosts.moderationLabels} && ${adultLabels})`,
      sql`not (${nagiPosts.selfLabels} && ${adultLabels})`,
      cursor ? or(lt(nagiPosts.indexedAt, cursor[0]), and(eq(nagiPosts.indexedAt, cursor[0]), lt(nagiPosts.uri, cursor[1]))) : undefined,
    ))
    .orderBy(desc(nagiPosts.indexedAt), desc(nagiPosts.uri))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit).map((row) => ({
    uri: row.uri,
    text: row.text,
    indexedAt: row.indexedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    author: { did: row.did, handle: row.handle ?? row.did, displayName: row.displayName ?? undefined },
  }));
  const last = rows[opts.limit - 1];
  return {
    items,
    hasMore: rows.length > opts.limit,
    ...(rows.length > opts.limit && last ? { cursor: encodeCursor(last.indexedAt, last.uri) } : {}),
  };
}
