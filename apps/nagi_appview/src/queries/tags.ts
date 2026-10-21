import { nagiPosts } from "@bsky-affirmative-bot/database";
import { sql, type SQL } from "drizzle-orm";

/** 検索・ミュート・タブで共通のタグ正規形。取り込み時の extractTags と同じく、先頭の # / ＃ を除いた小文字。 */
export const normalizeTag = (raw: string): string =>
  raw.trim().replace(/^[#＃]+/, "").trim().toLowerCase();

/** チャンネル名を normalizeTag と同じ規則で正規化する SQL 式。 */
const channelTagExpr = sql`lower(btrim(regexp_replace(channel.name, '^[#＃]+', '')))`;

/**
 * 投稿が tags のどれかを持つか。
 *
 * チャンネルは廃止してハッシュタグへ統合した。チャンネルページからの投稿やチャンネル内の返信は
 * 本文に #タグ を持たないので、channel_uri を持つ投稿は「チャンネル名のタグ付き」として扱う。
 * channel_uri は取り込み時にスレッドルートから返信へ配られるので、返信もここで一致する。
 * tags 列へ焼き込まないのは、ルートの編集で所属が変わったときに返信側を追従させずに済むため。
 *
 * チャンネル側は相関させず array(...) で1回だけ評価する。こうすると tags の GIN 索引と
 * channel_uri の索引を BitmapOr で併用でき、投稿テーブルの全走査にならない。
 *
 * tags も channel_uri も NULL 可なので、タグの無い投稿では false ではなく NULL になる。
 * 絞り込み（where に置くだけ）ならそれでよいが、否定するときは postLacksTags を使うこと。
 */
export function postHasAnyTag(tags: string[]): SQL {
  const param = sql`${sql.param(tags)}::text[]`;
  return sql`(
    ${nagiPosts.tags} && ${param}
    or ${nagiPosts.channelUri} = any(array(
      select channel.uri from nagi.channels as channel
      where ${channelTagExpr} = any(${param})
    ))
  )`;
}

/**
 * 投稿が tags のどれも持たないか（タグミュート用）。NULL を false に畳んでから否定する。
 * 素の `not postHasAnyTag(...)` だと NULL のままになり、タグの無い投稿まで全部消える。
 */
export const postLacksTags = (tags: string[]): SQL =>
  sql`not coalesce(${postHasAnyTag(tags)}, false)`;
