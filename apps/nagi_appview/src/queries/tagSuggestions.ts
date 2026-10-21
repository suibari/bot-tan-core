import { db, nagiPosts } from "@bsky-affirmative-bot/database";
import { and, sql } from "drizzle-orm";
import { normalizeTag } from "./tags.js";
import { adultContentVisibility } from "./timeline.js";

export type TagSuggestion = { tag: string; count: number };

/** 集計結果を使い回す時間。候補は打鍵ごとに来るので、投稿テーブルの集計は毎回やらない。 */
const CACHE_TTL_MS = 5 * 60_000;
/** 保持するタグの上限。投稿数の多い順に持つので、あふれるのは1〜2件しか使われていないタグ。 */
const MAX_TAGS = 20_000;

let cache: { at: number; tags: Promise<TagSuggestion[]> } | undefined;

/**
 * 投稿欄の #タグ 候補の母集団。共有TLに出る投稿だけを数える。
 *
 * 認証なしの公開APIなので、こっそり（スレッドルートがこっそりの返信を含む）・削除済みは数えず、
 * 成人向けの判定も未成年ビューアと同じ側に倒す。候補はタグ名そのものが見えるので、
 * タイムラインで見えない投稿のタグを出すと、その投稿があることが漏れる。
 *
 * チャンネル時代の投稿は本文に #タグ を持たないので、postHasAnyTag と同じく
 * チャンネル名をタグとして数える。同じ投稿が本文とチャンネルで同じタグを持っても1件。
 */
export async function loadTagCounts(): Promise<TagSuggestion[]> {
  const visible = and(
    sql`${nagiPosts.deletedAt} is null`,
    sql`not ${nagiPosts.kossori}`,
    sql`(
      ${nagiPosts.replyRootUri} is null
      or coalesce((
        select not thread_root.kossori
        from nagi.posts as thread_root
        where thread_root.uri = ${nagiPosts.replyRootUri}
          and thread_root.deleted_at is null
      ), false)
    )`,
    ...adultContentVisibility(false),
  );
  const rows = await db.execute<{ tag: string; count: number }>(sql`
    select tagged.tag, count(distinct tagged.uri)::int as count
    from (
      select ${nagiPosts.uri} as uri, unnest(${nagiPosts.tags}) as tag
      from ${nagiPosts}
      where ${nagiPosts.tags} is not null and ${visible}
      union all
      select ${nagiPosts.uri} as uri,
        lower(btrim(regexp_replace(channel.name, '^[#＃]+', ''))) as tag
      from ${nagiPosts}
      join nagi.channels as channel on channel.uri = ${nagiPosts.channelUri}
      where ${nagiPosts.channelUri} is not null and ${visible}
    ) as tagged
    where tagged.tag <> ''
    group by tagged.tag
    order by count desc, tagged.tag
    limit ${MAX_TAGS}
  `);
  return [...rows].map((row) => ({ tag: row.tag, count: Number(row.count) }));
}

/** 前方一致で絞り、投稿数の多い順（同数はタグ名順）に limit 件返す。tags は投稿数順に並んでいる前提。 */
export function rankTagSuggestions(
  tags: readonly TagSuggestion[],
  rawQuery: string,
  limit: number,
): TagSuggestion[] {
  const q = normalizeTag(rawQuery);
  if (!q) return [];
  const out: TagSuggestion[] = [];
  for (const tag of tags) {
    if (!tag.tag.startsWith(q)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

/** 既存ハッシュタグの入力候補。q は # の有無・大文字小文字を問わない。 */
export async function searchTags(
  rawQuery: string,
  limit: number,
  now = Date.now(),
): Promise<{ tags: TagSuggestion[] }> {
  if (!normalizeTag(rawQuery)) return { tags: [] };
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    const entry = { at: now, tags: loadTagCounts() };
    cache = entry;
    // 失敗した集計は持ち越さない。次の打鍵で取り直す。
    entry.tags.catch(() => {
      if (cache === entry) cache = undefined;
    });
  }
  return { tags: rankTagSuggestions(await cache.tags, rawQuery, limit) };
}
