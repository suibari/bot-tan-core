import { db, nagiEmojis } from "@bsky-affirmative-bot/database";
import {
  BLUEMOJI_ITEM,
  type BluemojiItem,
  type EmojiView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import {
  isNormalizedBluemojiFormats,
  normalizeBluemojiFormats,
  validateRecord,
} from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";
import { resolvePdsUrl } from "../util/pds.js";

export type EmojiRow = typeof nagiEmojis.$inferSelect;
export type EmojiAliasRequest = { name: string; preferredUri?: string };
export type EmojiAliasResolution = { name: string; emoji?: EmojiView };
// drizzle のトランザクションもこの形を満たすので、ingest からは tx を渡せる。
type Executor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

const displayableEmoji = and(
  eq(nagiEmojis.adultOnly, false),
  sql<boolean>`
    ${nagiEmojis.formats}->>'version' = '1'
    and ${nagiEmojis.formats}->'asset'->>'kind' in ('blob', 'bytes')
    and length(${nagiEmojis.formats}->'asset'->>'value') > 0
    and (
      ${nagiEmojis.formats}->'asset'->>'mediaType' like 'image/%'
      or ${nagiEmojis.formats}->'asset'->>'mediaType' = 'application/lottie+zip'
    )
  `,
)!;

export function emojiView(row: EmojiRow): EmojiView | null {
  if (!isNormalizedBluemojiFormats(row.formats)) return null;
  const { asset } = row.formats;
  const url = `/api/emoji-asset/${encodeURIComponent(row.did)}/${encodeURIComponent(
    row.uri.slice(row.uri.lastIndexOf("/") + 1),
  )}/${encodeURIComponent(row.cid)}`;
  const formats: NonNullable<EmojiView["formats"]> = {
    $type: "blue.moji.richtext.facet#formats_v0",
    ...(asset.mediaType === "application/lottie+zip"
      ? { lottie: true }
      : asset.mediaType === "image/apng"
        ? { apng_128: true }
        : asset.kind === "blob" && asset.mediaType === "image/png"
          ? { png_128: asset.value }
          : asset.kind === "blob" && asset.mediaType === "image/webp"
            ? { webp_128: asset.value }
            : asset.kind === "blob" && asset.mediaType === "image/gif"
              ? { gif_128: asset.value }
              : {}),
  };
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    name: row.name,
    alt: row.alt ?? undefined,
    url,
    mediaType: asset.mediaType,
    ...(Object.keys(formats).length > 1 ? { formats } : {}),
  };
}

/**
 * blue.moji.collection.item をインデックスする。record は検証済みであること。
 * 自己申告される formats はここ（＝レコード本体）の値だけを信頼する。
 */
export async function indexEmoji(
  executor: Executor,
  input: { uri: string; cid: string; did: string; record: any },
) {
  const { uri, cid, did, record } = input;
  const values = {
    uri,
    cid,
    did,
    name: record.name as string,
    alt: typeof record.alt === "string" ? record.alt : null,
    formats: normalizeBluemojiFormats(record.formats)!,
    adultOnly: record.adultOnly === true,
    createdAt: new Date(record.createdAt),
  };
  // 段階デプロイ中は旧 UNIQUE(did, name) が残っていても動作させる。
  // 旧制約下では同名・別URIの INSERT だけが no-op になり、制約撤去後の
  // reconcile でURIごとの行が追加される。同じURIの現在値は常に下のUPDATEで追従する。
  await executor
    .insert(nagiEmojis)
    .values({ ...values, moderationLabels: [], moderationVersion: null })
    .onConflictDoNothing();
  await executor
    .update(nagiEmojis)
    .set({
      ...values,
      // 中身が変わった（cid 変化）ときだけ判定待ちに戻す。reconcile や参照による
      // 再取り込みで同じ絵文字を何度も判定し直さないため。
      moderationLabels: sql`case when ${nagiEmojis.cid} is distinct from ${cid} then '{}'::text[] else ${nagiEmojis.moderationLabels} end`,
      moderationVersion: sql`case when ${nagiEmojis.cid} is distinct from ${cid} then null else ${nagiEmojis.moderationVersion} end`,
    })
    .where(eq(nagiEmojis.uri, uri));
}

const NEGATIVE_TTL_MS = 5 * 60_000;
const negativeCache = new Map<string, number>();

async function fetchEmojiRecord(uri: string) {
  const [, , did, collection, rkey] = uri.split("/");
  if (collection !== BLUEMOJI_ITEM || !did || !rkey) return null;
  const url = await resolvePdsUrl(did);
  url.pathname = "/xrpc/com.atproto.repo.getRecord";
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", rkey);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const body: any = await response.json();
  const record = body?.value;
  if (typeof body?.cid !== "string") return null;
  if (!validateRecord(BLUEMOJI_ITEM, record)) return null;
  return { uri, cid: body.cid as string, did, record };
}

/**
 * インデックス済みのカスタム絵文字を返す。未知の URI は参照された時点で
 * 元 PDS から取得してインデックスする（オンデマンド取り込み）。
 */
export async function resolveEmoji(uri: string): Promise<EmojiRow | null> {
  const indexed = await db
    .select()
    .from(nagiEmojis)
    .where(eq(nagiEmojis.uri, uri))
    .limit(1);
  if (indexed[0]) return indexed[0];

  const failedAt = negativeCache.get(uri);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_TTL_MS)
    return null;
  try {
    const fetched = await fetchEmojiRecord(uri);
    if (!fetched) {
      negativeCache.set(uri, Date.now());
      return null;
    }
    await indexEmoji(db, fetched);
    const rows = await db
      .select()
      .from(nagiEmojis)
      .where(eq(nagiEmojis.uri, uri))
      .limit(1);
    return rows[0] ?? null;
  } catch (e) {
    console.error("[emoji] on-demand index failed", uri, e);
    negativeCache.set(uri, Date.now());
    return null;
  }
}

/**
 * 設定一覧はPDS上の準拠レコードをすべて表示する。同名の新しいレコードが意味キーを
 * 代表していてDBへ入らない旧URIでも、要求CIDのPDSレコード自体を検証して資産を返す。
 */
export async function resolveEmojiAsset(uri: string, expectedCid: string) {
  const fetched = await fetchEmojiRecord(uri);
  if (!fetched || fetched.cid !== expectedCid) return null;
  await indexEmoji(db, fetched);
  return normalizeBluemojiFormats((fetched.record as BluemojiItem).formats);
}

export async function getEmoji(uri: string) {
  if (!uri.startsWith("at://") || uri.split("/")[3] !== BLUEMOJI_ITEM)
    throw new ApiError(400, "invalid_request", "Invalid Bluemoji URI");
  const row = await resolveEmoji(uri);
  const view = row ? emojiView(row) : null;
  if (!view) throw new ApiError(404, "not_found", "Emoji not found");
  return { emoji: view };
}

/**
 * 同名候補が複数あるときは、返信元が実際に使った URI を最優先し、それ以外は
 * ピッカー検索と同じ indexedAt / URI の降順で先頭を選ぶ。
 */
export function selectEmojiAliasResolutions(
  requests: EmojiAliasRequest[],
  candidates: EmojiView[],
): EmojiAliasResolution[] {
  return requests.map((request) => {
    const emoji =
      (request.preferredUri
        ? candidates.find(
            (candidate) =>
              candidate.uri === request.preferredUri &&
              candidate.name === request.name,
          )
        : undefined) ??
      candidates.find((candidate) => candidate.name === request.name);
    return { name: request.name, ...(emoji ? { emoji } : {}) };
  });
}

/** botたんの生成文にあるエイリアスを、表示可能なインデックス済み絵文字へ一括解決する。 */
export async function resolveEmojiAliases(
  requests: EmojiAliasRequest[],
): Promise<EmojiAliasResolution[]> {
  if (!requests.length) return [];
  const names = [...new Set(requests.map((request) => request.name))];
  const preferredUris = [
    ...new Set(requests.flatMap((request) => request.preferredUri ?? [])),
  ];
  const identity = preferredUris.length
    ? or(inArray(nagiEmojis.name, names), inArray(nagiEmojis.uri, preferredUris))
    : inArray(nagiEmojis.name, names);
  const rows = await db
    .select()
    .from(nagiEmojis)
    .where(and(displayableEmoji, identity))
    .orderBy(desc(nagiEmojis.indexedAt), desc(nagiEmojis.uri));
  return selectEmojiAliasResolutions(
    requests,
    rows.flatMap((row) => emojiView(row) ?? []),
  );
}

export async function searchEmojis(params: {
  q?: string;
  repo?: string;
  excludeRepo?: string;
  limit: number;
  cursor?: string;
}) {
  const { q, repo, excludeRepo, limit, cursor } = params;
  const conditions = [
    // adultOnly・旧形式・表示不能な資産はピッカーにもbotたんにも渡さない。
    displayableEmoji,
  ];
  if (q)
    conditions.push(
      ilike(nagiEmojis.name, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
    );
  if (repo) conditions.push(eq(nagiEmojis.did, repo));
  if (excludeRepo)
    conditions.push(sql<boolean>`${nagiEmojis.did} <> ${excludeRepo}`);
  if (cursor) {
    const [indexedAt, uri] = cursor.split("::");
    const at = new Date(indexedAt);
    if (!Number.isNaN(at.valueOf()) && uri)
      conditions.push(
        or(
          lt(nagiEmojis.indexedAt, at),
          and(eq(nagiEmojis.indexedAt, at), lt(nagiEmojis.uri, uri)),
        )!,
      );
  }
  const rows = await db
    .select()
    .from(nagiEmojis)
    .where(and(...conditions))
    .orderBy(desc(nagiEmojis.indexedAt), desc(nagiEmojis.uri))
    .limit(limit);
  const last = rows[rows.length - 1];
  return {
    emojis: rows.flatMap((row) => emojiView(row) ?? []),
    cursor:
      rows.length === limit && last
        ? `${last.indexedAt.toISOString()}::${last.uri}`
        : undefined,
  };
}
