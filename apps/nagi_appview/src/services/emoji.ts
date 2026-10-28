import {
  db,
  embeddingProfile,
  embedSearchQuery,
  nagiEmojis,
  nagiUnicodeEmojis,
} from "@bsky-affirmative-bot/database";
import {
  BLUEMOJI_ITEM,
  type BluemojiItem,
  type EmojiView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  isNormalizedBluemojiFormats,
  normalizeBluemojiFormats,
  validateRecord,
} from "../ingest/validateRecord.js";
import { ApiError } from "../middleware/errors.js";
import { relativeCut } from "../queries/hybridSearch.js";
import {
  HIRAGANA,
  KATAKANA,
  escapeLike,
  kanaToRomaji,
  normalizeEmojiText,
} from "./emojiSearchText.js";
import { resolvePdsUrl } from "../util/pds.js";

/**
 * 表示に使う列。検索用の embedding（1024次元）と読み取り文は一覧のたびに運ばない。
 */
const { embedding: _embedding, searchText: _searchText, searchTextCid: _searchTextCid, ...emojiColumnSet } =
  getTableColumns(nagiEmojis);
export const emojiColumns = emojiColumnSet;
export type EmojiRow = Omit<
  typeof nagiEmojis.$inferSelect,
  "embedding" | "searchText" | "searchTextCid"
>;
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
    .select(emojiColumns)
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
      .select(emojiColumns)
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
    .select(emojiColumns)
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
    .select(emojiColumns)
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

export type UnicodeEmojiView = { emoji: string; labelJa: string; labelEn: string };

const unicodeColumns = {
  emoji: nagiUnicodeEmojis.emoji,
  labelJa: nagiUnicodeEmojis.labelJa,
  labelEn: nagiUnicodeEmojis.labelEn,
};

/**
 * 意味検索で語彙一致の後ろに足す件数の上限。裾ほど関係が薄くなるので、
 * ページングせず打ち止めにする（hybridSearch.ts の SEMANTIC_LIMIT と同じ考え方）。
 */
const SEMANTIC_EMOJI_LIMIT = 12;

/** タイプアヘッドは打鍵ごとに来るので、同じ語の埋め込みを使い回す。 */
const QUERY_EMBEDDING_TTL_MS = 10 * 60_000;
const QUERY_EMBEDDING_CACHE_SIZE = 256;
const queryEmbeddings = new Map<string, { at: number; embedding: number[] }>();

async function embedEmojiQuery(q: string): Promise<number[] | null> {
  const cached = queryEmbeddings.get(q);
  if (cached && Date.now() - cached.at < QUERY_EMBEDDING_TTL_MS) return cached.embedding;
  const embedding = await embedSearchQuery(q, { target: "emojis" }).catch(() => null);
  // 失敗はキャッシュしない（Ollama が戻れば次の打鍵で意味検索が復帰する）。
  if (!embedding) return null;
  queryEmbeddings.delete(q);
  queryEmbeddings.set(q, { at: Date.now(), embedding });
  if (queryEmbeddings.size > QUERY_EMBEDDING_CACHE_SIZE)
    queryEmbeddings.delete(queryEmbeddings.keys().next().value!);
  return embedding;
}

const vectorParam = (embedding: number[]) =>
  sql`${`[${embedding.join(",")}]`}::vector`;

/** 語彙一致の LIKE パターン。q は正規化済み。 */
function likePatterns(q: string) {
  const escaped = escapeLike(q);
  return {
    exact: q,
    prefix: `${escaped}%`,
    contains: `%${escaped}%`,
    // 改行区切りの1行と完全一致 / 行頭一致。
    line: `%\n${escaped}\n%`,
    linePrefix: `%\n${escaped}%`,
  };
}

/**
 * カスタム絵文字の語彙一致。名前・alt・視覚モデルが読み取った文字と連想語を見る。
 * 並びは 0:名前と完全一致 / 1:名前の前方一致・画像の文字と完全一致 /
 * 2:名前の部分一致・連想語と完全一致 / 3:それ以外の部分一致。同点は本人の絵文字を先に。
 *
 * 名前は区切り（`-` `_` 空白）を外して照合する。同じ語でも `:bot-tan_duel:` と
 * `:bottan-igyo:` のように区切り方が人によって違い、「bottan」で片方しか出なかった。
 * かなの検索語はローマ字にしても照合する
 * （「ざんねん」→ :zannen:、「よろしくおねがいします」→ :yoroshiku_onegaishimasu:）。
 * 外来語はヘボン式と綴りがずれる（「ラテ」→ rate、名前は latte）ので、ローマ字のときだけ
 * L/R を同一視し、同じ文字の連続を畳んだ形（rate）でも部分一致を見る。
 */
async function searchCustomLexical(q: string, limit: number, preferRepo?: string) {
  const p = likePatterns(q);
  const name = sql`lower(${nagiEmojis.name})`;
  const flatName = sql`translate(${name}, '_- ', '')`;
  const flat = (value: string) => value.replace(/[_\-\s]/g, "");
  const keys = [
    ...new Set([flat(q), flat(kanaToRomaji(q) ?? "")].filter(Boolean)),
  ].map(likePatterns);
  const any = (each: (k: ReturnType<typeof likePatterns>) => SQL) =>
    keys.length ? or(...keys.map(each))! : sql`false`;
  const flatExact = any((k) => sql`${flatName} = ${`:${k.exact}:`}`);
  const flatPrefix = any((k) => sql`${flatName} like ${`:${k.prefix}`}`);
  const flatContains = any((k) => sql`${flatName} like ${k.contains}`);
  const romaji = kanaToRomaji(q);
  const loose = (value: string) => value.replace(/l/g, "r").replace(/(.)\1+/g, "$1");
  const looseName = sql`regexp_replace(translate(${flatName}, 'l', 'r'), '(.)\\1+', '\\1', 'g')`;
  const looseContains = romaji
    ? sql`${looseName} like ${likePatterns(loose(romaji.replace(/[_\-\s]/g, ""))).contains}`
    : sql`false`;
  // DB 側の正規化。名前と違い、読み取り文と alt は日本語なのでかな揺れを畳む。
  const text = sql`translate(lower(coalesce(${nagiEmojis.searchText}, '') || E'\n' || coalesce(${nagiEmojis.alt}, '')), ${HIRAGANA}, ${KATAKANA})`;
  const lines = sql`(E'\n' || ${text} || E'\n')`;
  const score = sql<number>`case
    when ${name} = ${`:${q}:`} or ${flatExact} then 0
    when ${name} like ${`:${p.prefix}`} or ${flatPrefix} then 1
    when split_part(${text}, E'\n', 1) = ${p.exact} then 1
    when ${name} like ${p.contains} or ${flatContains} or ${looseContains} then 2
    when ${lines} like ${p.line} then 2
    else 3 end`;
  const own: SQL = preferRepo
    ? sql`(${nagiEmojis.did} = ${preferRepo}) desc`
    : sql`1`;
  return db
    .select(emojiColumns)
    .from(nagiEmojis)
    .where(
      and(
        displayableEmoji,
        or(
          sql`${name} like ${p.contains}`,
          sql`${text} like ${p.contains}`,
          flatContains,
          looseContains,
        ),
      ),
    )
    .orderBy(score, own, desc(nagiEmojis.indexedAt), desc(nagiEmojis.uri))
    .limit(limit);
}

/**
 * 語彙一致した行は除いて返すが、相対カットの基準（最良距離）には含める。除いてから切ると、
 * 「ねこ」で 🐱 を除いた残りの最良（🦊）が基準になり、鳥まで仲間に入ってしまう。
 */
async function searchCustomSemantic(embedding: number[], exclude: string[]) {
  // postgres.js は float8 を文字列で返すので数値へ直す（relativeCut が比較できなくなる）。
  const distance = sql<number>`(${nagiEmojis.embedding} <=> ${vectorParam(embedding)})`.mapWith(Number);
  const rows = await db
    .select({ row: emojiColumns, distance })
    .from(nagiEmojis)
    .where(
      and(
        displayableEmoji,
        isNotNull(nagiEmojis.embedding),
        sql`${distance} < ${embeddingProfile().emojiDistMax}`,
      ),
    )
    .orderBy(distance)
    .limit(SEMANTIC_EMOJI_LIMIT + exclude.length);
  const excluded = new Set(exclude);
  return relativeCut(rows, (r) => r.distance, embeddingProfile().emojiRelMargin)
    .filter((r) => !excluded.has(r.row.uri))
    .slice(0, SEMANTIC_EMOJI_LIMIT);
}

/**
 * Unicode 絵文字の語彙一致。クライアントの unicodeSearch.ts と同じく
 * 表示名 > ショートコード・タグ、完全一致 > 前方一致 > 部分一致 の順。
 */
async function searchUnicodeLexical(q: string, limit: number) {
  const p = likePatterns(q);
  const labels = sql`(E'\n' || ${nagiUnicodeEmojis.labels} || E'\n')`;
  const keywords = sql`(E'\n' || ${nagiUnicodeEmojis.keywords} || E'\n')`;
  const score = sql<number>`case
    when ${labels} like ${p.line} then 0
    when ${labels} like ${p.linePrefix} then 1
    when ${keywords} like ${p.line} then 2
    when ${keywords} like ${p.linePrefix} then 3
    else 4 end`;
  return db
    .select(unicodeColumns)
    .from(nagiUnicodeEmojis)
    .where(sql`${nagiUnicodeEmojis.keywords} like ${p.contains}`)
    // 同点なら ZWJ 合字より単体を先に。
    .orderBy(
      score,
      sql`char_length(${nagiUnicodeEmojis.emoji})`,
      asc(nagiUnicodeEmojis.sortOrder),
    )
    .limit(limit);
}

async function searchUnicodeSemantic(embedding: number[], exclude: string[]) {
  const distance = sql<number>`(${nagiUnicodeEmojis.embedding} <=> ${vectorParam(embedding)})`.mapWith(
    Number,
  );
  const rows = await db
    .select({ row: unicodeColumns, distance })
    .from(nagiUnicodeEmojis)
    .where(
      and(
        isNotNull(nagiUnicodeEmojis.embedding),
        sql`${distance} < ${embeddingProfile().emojiDistMax}`,
      ),
    )
    .orderBy(distance)
    .limit(SEMANTIC_EMOJI_LIMIT + exclude.length);
  const excluded = new Set(exclude);
  return relativeCut(rows, (r) => r.distance, embeddingProfile().emojiRelMargin)
    .filter((r) => !excluded.has(r.row.emoji))
    .slice(0, SEMANTIC_EMOJI_LIMIT);
}

/**
 * 絵文字の意味検索。カスタム絵文字は常に Unicode 絵文字より上に並べる
 * （ピッカーの結果は emojis → unicode の順に表示する）。それぞれの中では
 * 語彙一致を先に、その後ろへ意味の近いものを足す。
 *
 * 埋め込みが取れない（Ollama 不通）ときは語彙一致だけで返す。
 * 意味検索の裾は打ち止めなので、ページングはしない（cursor を返さない）。
 */
export async function searchEmojisSemantic(params: {
  q: string;
  limit: number;
  includeUnicode: boolean;
  preferRepo?: string;
}): Promise<{ emojis: EmojiView[]; unicode?: UnicodeEmojiView[] }> {
  const raw = params.q.replace(/^:+|:+$/g, "").trim();
  const q = normalizeEmojiText(raw);
  if (!q) return { emojis: [], ...(params.includeUnicode ? { unicode: [] } : {}) };

  const [embedding, customLexical, unicodeLexical] = await Promise.all([
    // 埋め込みには打ったままの表記を渡す。語彙一致用のカタカナ化を通すと
    // 「かなしい」が「カナシイ」になって 🦀（カニ）に、「ありがとう」が 🐜（アリ）に寄る。
    embedEmojiQuery(raw),
    searchCustomLexical(q, params.limit, params.preferRepo),
    params.includeUnicode ? searchUnicodeLexical(q, params.limit) : Promise.resolve([]),
  ]);
  const [customSemantic, unicodeSemantic] = embedding
    ? await Promise.all([
        customLexical.length < params.limit
          ? searchCustomSemantic(embedding, customLexical.map((r) => r.uri))
          : Promise.resolve([]),
        params.includeUnicode && unicodeLexical.length < params.limit
          ? searchUnicodeSemantic(embedding, unicodeLexical.map((r) => r.emoji))
          : Promise.resolve([]),
      ])
    : [[], []];

  const emojis = [...customLexical, ...customSemantic.map((r) => r.row)]
    .slice(0, params.limit)
    .flatMap((row) => emojiView(row) ?? []);
  if (!params.includeUnicode) return { emojis };
  const unicode = [...unicodeLexical, ...unicodeSemantic.map((r) => r.row)]
    .slice(0, params.limit)
    .map(({ emoji, labelJa, labelEn }) => ({ emoji, labelJa, labelEn }));
  return { emojis, unicode };
}
