import { createHash } from "node:crypto";
import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  bot_memory_daily_digests,
  bot_memory_documents,
  bot_memory_impressions,
  bot_memory_impression_scans,
  bot_memory_pronunciations,
  bot_memory_usages,
  db,
} from "./db.js";
import { embedSearchQuery } from "./ollamaEmbed.js";

export const BOT_MEMORY_SOURCE_TYPES = [
  "bsky_affirmed_post",
  "nagi_affirmed_post",
  "bsky_received_reply",
  "nagi_received_reply",
  "bsky_received_like",
  "nagi_received_reaction",
  "biorhythm",
  "youtube_live_comment",
  /**
   * botMemoryResearchWorker が SearXNG で調べた事実。
   *
   * 他の種別が「誰かとのやりとりの記憶」なのに対し、これだけは外部から仕入れた
   * 知識。思い出の枠を食わないよう、リプライ生成では selectReplyMemoryContext に
   * 通さず独立したブロックとして渡す。
   */
  "web_research",
] as const;

export type BotMemorySourceType = (typeof BOT_MEMORY_SOURCE_TYPES)[number];
export type BotMemoryPurpose =
  | "reply_history"
  | "scheduled_post"
  | "live_filler"
  | "live_reply";

/**
 * 反応イベントは旧YouTubeクライアントとのローリングデプロイ互換のため型には残すが、
 * 検索対象にはしない。反応された本文はbotたん自身の投稿であり、会話記憶ではない。
 */
export const BOT_MEMORY_ACTIVE_SOURCE_TYPES: readonly BotMemorySourceType[] =
  BOT_MEMORY_SOURCE_TYPES.filter(
    (sourceType) =>
      sourceType !== "bsky_received_like" &&
      sourceType !== "nagi_received_reaction",
  );

export function activeBotMemorySourceTypes(
  requested?: readonly BotMemorySourceType[],
): BotMemorySourceType[] {
  return (requested ?? BOT_MEMORY_ACTIVE_SOURCE_TYPES).filter((sourceType) =>
    BOT_MEMORY_ACTIVE_SOURCE_TYPES.includes(sourceType)
  );
}

export const REACTION_MEMORY_SOURCE_TYPES = [
  "bsky_received_like",
  "nagi_received_reaction",
] as const satisfies readonly BotMemorySourceType[];

export type ReactionMemoryPurgeSummary = {
  sourceType: (typeof REACTION_MEMORY_SOURCE_TYPES)[number];
  documents: number;
  usages: number;
};

export type ReactionMemoryPurgeDependencies = {
  loadSummary: () => Promise<ReactionMemoryPurgeSummary[]>;
  deleteDocuments: () => Promise<number>;
};

export async function loadReactionMemoryPurgeSummary(): Promise<ReactionMemoryPurgeSummary[]> {
  const documentRows = await db
    .select({
      sourceType: bot_memory_documents.source_type,
      count: sql<number>`count(*)::int`,
    })
    .from(bot_memory_documents)
    .where(inArray(bot_memory_documents.source_type, [...REACTION_MEMORY_SOURCE_TYPES]))
    .groupBy(bot_memory_documents.source_type);
  const usageRows = await db
    .select({
      sourceType: bot_memory_documents.source_type,
      count: sql<number>`count(*)::int`,
    })
    .from(bot_memory_usages)
    .innerJoin(
      bot_memory_documents,
      eq(bot_memory_documents.id, bot_memory_usages.document_id),
    )
    .where(inArray(bot_memory_documents.source_type, [...REACTION_MEMORY_SOURCE_TYPES]))
    .groupBy(bot_memory_documents.source_type);
  const documents = new Map(documentRows.map((row) => [row.sourceType, Number(row.count)]));
  const usages = new Map(usageRows.map((row) => [row.sourceType, Number(row.count)]));
  return REACTION_MEMORY_SOURCE_TYPES.map((sourceType) => ({
    sourceType,
    documents: documents.get(sourceType) ?? 0,
    usages: usages.get(sourceType) ?? 0,
  }));
}

async function deleteReactionMemoryDocuments() {
  const deleted = await db.transaction(async (tx) => tx
    .delete(bot_memory_documents)
    .where(inArray(bot_memory_documents.source_type, [...REACTION_MEMORY_SOURCE_TYPES]))
    .returning({ id: bot_memory_documents.id }));
  return deleted.length;
}

export async function purgeReactionBotMemory(
  shouldApply = false,
  dependencies: ReactionMemoryPurgeDependencies = {
    loadSummary: loadReactionMemoryPurgeSummary,
    deleteDocuments: deleteReactionMemoryDocuments,
  },
) {
  const before = await dependencies.loadSummary();
  if (!shouldApply) return { applied: false, before, deleted: 0 };
  const deleted = await dependencies.deleteDocuments();
  return { applied: true, before, deleted };
}

/**
 * 記憶を思い出せる範囲。
 *
 * - `public`  … 誰との会話でも思い出してよい。定期ポスト・ダッシュボードにも出せる
 * - `kossori` … **本人がこっそりで話しているときだけ**。公開出力には一切出さない
 */
export type BotMemoryVisibility = "public" | "kossori";

export function isBotMemoryVisibility(value: unknown): value is BotMemoryVisibility {
  return value === "public" || value === "kossori";
}

/**
 * 検索が引いてよい範囲。
 *
 * 既定（未指定）は public だけ。**許可を足す形にしてあるのが要点で**、
 * 新しい読み手が scope を渡し忘れても、こっそりが公開側へ漏れる方向には倒れない。
 */
export interface BotMemoryScope {
  /**
   * こっそりの文脈で話している本人の subjectKey。
   *
   * これが入っているときだけ「その人自身のこっそり記憶」が候補に加わる。
   * 他人のこっそりは誰の文脈でも出ない（author_id が一致しないため）。
   */
  kossoriSubjectKey?: string;
}

export interface BotMemoryDocumentInput {
  sourceType: BotMemorySourceType;
  sourceId: string;
  sourceUri?: string | null;
  authorId?: string | null;
  content: string;
  botResponse?: string | null;
  occurredAt: Date;
  affirmationScore?: number | null;
  metadata?: Record<string, unknown> | null;
  /** 省略時は public。こっそり投稿を覚えるときだけ "kossori" を渡す。 */
  visibility?: BotMemoryVisibility;
}

export interface BotMemorySearchRequest extends BotMemoryScope {
  query: string;
  purpose: BotMemoryPurpose;
  sources?: BotMemorySourceType[];
  authorId?: string;
  excludeAuthorId?: string;
  since?: Date;
  until?: Date;
  excludeDocumentIds?: number[];
  limit?: number;
}

export interface BotMemorySearchResult {
  id: number;
  sourceType: BotMemorySourceType;
  sourceId: string;
  sourceUri: string | null;
  authorId: string | null;
  content: string;
  botResponse: string | null;
  occurredAt: Date;
  affirmationScore: number | null;
  /** 印象度 0-100。未評価は null。 */
  salience: number | null;
  metadata: Record<string, unknown> | null;
  relevance: number;
  semanticRank?: number;
  lexicalRank?: number;
}

export type BotMemoryImpressionKind = "work" | "word";
export type BotMemoryImpressionRelation = "recommended" | "liked" | "discussed";

export interface BotMemoryImpressionInput {
  kind: BotMemoryImpressionKind;
  label: string;
  relation: BotMemoryImpressionRelation;
}

export interface PendingBotMemoryImpressionDocument {
  id: number;
  sourceType: BotMemorySourceType;
  content: string;
  contentHash: string;
  /** こっそり由来では印象語を作らない。判定の正は saveBotMemoryImpressions 側。 */
  visibility: string;
}

export interface DailyPlanMemoryImpression extends BotMemoryImpressionInput {
  id: number;
  source: "bsky" | "nagi" | "youtube";
  occurredAt: Date;
}

/** bot-tan.com で公開する、最近の会話から抽出された話題と任意の読み。 */
export interface RecentBotMemoryImpression {
  label: string;
  spokenForm: string | null;
  occurredAt: Date;
}

interface RecentBotMemoryImpressionRow extends RecentBotMemoryImpression {
  pronunciationStatus: string | null;
}

/**
 * 同じ話題が続いた場合は最新だけを残す。読みは active のときだけ公開し、
 * ignored / disabled や競合確認中の空値をフリガナとして扱わない。
 */
export function selectRecentBotMemoryImpressions(
  rows: RecentBotMemoryImpressionRow[],
  limit = 20,
): RecentBotMemoryImpression[] {
  const selected = new Map<string, RecentBotMemoryImpression>();
  for (const row of rows) {
    if (selected.has(row.label)) continue;
    selected.set(row.label, {
      label: row.label,
      spokenForm: row.pronunciationStatus === "active" ? row.spokenForm : null,
      occurredAt: row.occurredAt,
    });
    if (selected.size >= Math.max(1, Math.min(50, limit))) break;
  }
  return [...selected.values()];
}

export function selectReplyMemoryContext(
  ownRows: BotMemorySearchResult[],
  friendRows: BotMemorySearchResult[],
  excludedAuthorIds: Iterable<string | undefined> = [],
) {
  const excluded = new Set([...excludedAuthorIds].filter(
    (value): value is string => Boolean(value),
  ));
  return {
    relatedPosts: ownRows.map((row) => row.content),
    // embedding障害時はlexicalだけになる。本人履歴には有用だが、友達の誤紹介は避ける。
    friendMemory: friendRows.find((row) =>
      row.semanticRank !== undefined &&
      Boolean(row.authorId) &&
      Boolean(row.sourceUri) &&
      !excluded.has(row.authorId!)
    ),
  };
}

/** YouTube のチャンネルIDに付ける名前空間の印。 */
const YOUTUBE_SUBJECT_PREFIX = "youtube:";

/**
 * author_id の形を揃える。
 *
 * この列には Nagi/Bluesky の `did:plc:...` と YouTube のチャンネルID `UC...` が
 * 同居している。形式が違うので現状は衝突しないが、こっそりの可視判定が
 * `author_id = kossoriSubjectKey` の一致に乗った以上、その偶然に依存したくない。
 *
 * **名寄せはしない。** 同一人物が Nagi と YouTube で別人として扱われるのは意図的な
 * 割り切りで、ここでやるのは名前空間の印付けだけ。
 *
 * 冪等。すでに印が付いている値をもう一度通しても二重にならない。
 */
export function normalizeMemorySubjectKey(
  sourceType: BotMemorySourceType,
  rawId: string | null | undefined,
): string | null {
  const id = rawId?.trim();
  if (!id) return null;
  if (sourceType !== "youtube_live_comment") return id;
  return id.startsWith(YOUTUBE_SUBJECT_PREFIX) ? id : `${YOUTUBE_SUBJECT_PREFIX}${id}`;
}

/**
 * 0-100 の整数へ丸める。LLM は範囲外や小数を返してくるので、DB の CHECK 前に潰す。
 *
 * **null / undefined / 空文字は 0 ではなく null**。`Number(null)` は 0 なので、
 * 素直に Number() へ通すと「未評価」が「まったく印象に残らなかった」になってしまう。
 * この2つは意味が違う（未評価はあとで付け直せるが、0 は確定した低評価）。
 */
export function clampSalience(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export const botMemoryContentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

/**
 * この投稿を記憶に残すか。
 *
 * `sourceAlive` は「AppView に生きている行があるか（削除されていないか）」。
 * かつては「公開されているか」だったが、こっそりも visibility 付きで覚えるように
 * なったので、公開かどうかはここではなく BotMemoryDocumentInput.visibility が持つ。
 */
export function shouldRememberAffirmedPost(input: {
  surface: "bsky" | "nagi";
  aiReplyPosted: boolean;
  isTopLevel: boolean;
  sourceAlive: boolean;
  isSubscriber?: boolean;
}) {
  return input.aiReplyPosted && input.isTopLevel && input.sourceAlive &&
    (input.surface === "nagi" || input.isSubscriber === true);
}

export function isBotMemorySourceType(value: unknown): value is BotMemorySourceType {
  return typeof value === "string" &&
    (BOT_MEMORY_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * 同じ source は1行だけ持つ。本文が同じ再試行では embedding を保ち、編集時だけ再生成する。
 */
export async function upsertBotMemoryDocument(input: BotMemoryDocumentInput) {
  const content = input.content.trim();
  if (!content) return null;
  const contentHash = botMemoryContentHash(content);
  // どの経路から来ても author_id の形が揃うよう、入口で正規化する。
  const authorId = normalizeMemorySubjectKey(input.sourceType, input.authorId);
  const [row] = await db
    .insert(bot_memory_documents)
    .values({
      source_type: input.sourceType,
      source_id: input.sourceId,
      source_uri: input.sourceUri ?? null,
      author_id: authorId,
      content,
      bot_response: input.botResponse ?? null,
      occurred_at: input.occurredAt,
      affirmation_score: input.affirmationScore ?? null,
      metadata: input.metadata ?? null,
      visibility: input.visibility ?? "public",
      content_hash: contentHash,
    })
    .onConflictDoUpdate({
      target: [bot_memory_documents.source_type, bot_memory_documents.source_id],
      set: {
        source_uri: input.sourceUri ?? null,
        author_id: authorId,
        content,
        bot_response: input.botResponse ?? null,
        occurred_at: input.occurredAt,
        affirmation_score: input.affirmationScore ?? null,
        metadata: input.metadata ?? null,
        visibility: input.visibility ?? "public",
        content_hash: contentHash,
        embedding: sql`case when ${bot_memory_documents.content_hash} is distinct from ${contentHash} then null else ${bot_memory_documents.embedding} end`,
        embedding_model: sql`case when ${bot_memory_documents.content_hash} is distinct from ${contentHash} then null else ${bot_memory_documents.embedding_model} end`,
        deleted_at: null,
        updated_at: new Date(),
      },
    })
    .returning();
  return row ?? null;
}

/** 記憶基盤の障害で、すでに成功した返信や元サービスの処理を巻き戻さない。 */
export async function tryUpsertBotMemoryDocument(input: BotMemoryDocumentInput) {
  try {
    return await upsertBotMemoryDocument(input);
  } catch (error) {
    console.error("[ERROR][BOT_MEMORY] upsert failed; source processing continues", {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      error,
    });
    return null;
  }
}

export async function updateBotMemoryResponse(
  sourceType: BotMemorySourceType,
  sourceId: string,
  botResponse: string,
) {
  await db
    .update(bot_memory_documents)
    .set({ bot_response: botResponse, updated_at: new Date() })
    .where(and(
      eq(bot_memory_documents.source_type, sourceType),
      eq(bot_memory_documents.source_id, sourceId),
    ));
}

export async function tombstoneBotMemoryDocument(
  sourceType: BotMemorySourceType,
  sourceId: string,
) {
  await db
    .update(bot_memory_documents)
    .set({ deleted_at: new Date(), embedding: null, embedding_model: null, updated_at: new Date() })
    .where(and(
      eq(bot_memory_documents.source_type, sourceType),
      eq(bot_memory_documents.source_id, sourceId),
      isNull(bot_memory_documents.deleted_at),
    ));
}

export async function tombstoneBotMemoriesByUri(sourceUri: string) {
  await db
    .update(bot_memory_documents)
    .set({ deleted_at: new Date(), embedding: null, embedding_model: null, updated_at: new Date() })
    .where(and(
      eq(bot_memory_documents.source_uri, sourceUri),
      isNull(bot_memory_documents.deleted_at),
    ));
}

export async function tombstoneBotMemoriesBySubjectUri(subjectUri: string) {
  await db
    .update(bot_memory_documents)
    .set({ deleted_at: new Date(), embedding: null, embedding_model: null, updated_at: new Date() })
    .where(and(
      sql`${bot_memory_documents.metadata}->>'subjectUri' = ${subjectUri}`,
      isNull(bot_memory_documents.deleted_at),
    ));
}

/** 元投稿の編集を、すでに取り込まれている記憶だけへ反映する。新規行は作らない。 */
export async function updateBotMemoriesByUri(sourceUri: string, content: string) {
  const normalized = content.trim();
  if (!normalized) {
    await tombstoneBotMemoriesByUri(sourceUri);
    return;
  }
  const contentHash = botMemoryContentHash(normalized);
  await db
    .update(bot_memory_documents)
    .set({
      content: normalized,
      content_hash: contentHash,
      embedding: sql`case when ${bot_memory_documents.content_hash} is distinct from ${contentHash} then null else ${bot_memory_documents.embedding} end`,
      embedding_model: sql`case when ${bot_memory_documents.content_hash} is distinct from ${contentHash} then null else ${bot_memory_documents.embedding_model} end`,
      updated_at: new Date(),
      deleted_at: null,
    })
    .where(eq(bot_memory_documents.source_uri, sourceUri));
}

export async function getPendingBotMemoryDocuments(limit = 16) {
  return db
    .select({
      id: bot_memory_documents.id,
      content: bot_memory_documents.content,
      contentHash: bot_memory_documents.content_hash,
    })
    .from(bot_memory_documents)
    .where(and(
      isNull(bot_memory_documents.deleted_at),
      isNull(bot_memory_documents.embedding),
    ))
    .orderBy(desc(bot_memory_documents.updated_at))
    .limit(Math.max(1, Math.min(100, limit)));
}

export async function saveBotMemoryEmbedding(
  id: number,
  contentHash: string,
  embedding: number[],
) {
  const updated = await db
    .update(bot_memory_documents)
    .set({
      embedding,
      embedding_model: aiModel("OLLAMA_EMBED"),
      updated_at: new Date(),
    })
    .where(and(
      eq(bot_memory_documents.id, id),
      eq(bot_memory_documents.content_hash, contentHash),
      isNull(bot_memory_documents.deleted_at),
    ))
    .returning({ id: bot_memory_documents.id });
  return updated.length > 0;
}

/**
 * 印象語を抽出する = 公開の記憶グラフに出しうる種別。
 *
 * biorhythm（botたん自身の記録）と web_research（外から仕入れた知識）は「誰かとの
 * 会話の記憶」ではないので含めない。botMemoryGraph も同じ集合を使う。
 */
export const IMPRESSION_SOURCE_TYPES: BotMemorySourceType[] = [
  "bsky_affirmed_post",
  "bsky_received_reply",
  "nagi_affirmed_post",
  "nagi_received_reply",
  "youtube_live_comment",
];

export function isBotMemoryImpressionSourceType(
  sourceType: BotMemorySourceType,
): boolean {
  return IMPRESSION_SOURCE_TYPES.includes(sourceType);
}

/** 未処理、または編集後の公開会話を少量ずつ抽出workerへ渡す。 */
export async function getPendingBotMemoryImpressionDocuments(
  limit = 8,
  now = new Date(),
): Promise<PendingBotMemoryImpressionDocument[]> {
  const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: bot_memory_documents.id,
      sourceType: bot_memory_documents.source_type,
      content: bot_memory_documents.content,
      contentHash: bot_memory_documents.content_hash,
      visibility: bot_memory_documents.visibility,
    })
    .from(bot_memory_documents)
    .leftJoin(
      bot_memory_impression_scans,
      eq(bot_memory_impression_scans.document_id, bot_memory_documents.id),
    )
    .where(and(
      isNull(bot_memory_documents.deleted_at),
      // こっそりも通す。salience（印象度）は感情が動いた話にこそ付いてほしく、
      // それはこっそりに多いため。ただし印象語は公開出力（日次予定表・定期ポスト・
      // bot-tan.com）へ流れるので、こっそりからは作らない。書き分けは
      // saveBotMemoryImpressions がトランザクション内で行う（入口フィルタより強い）。
      inArray(bot_memory_documents.source_type, IMPRESSION_SOURCE_TYPES),
      gte(bot_memory_documents.occurred_at, since),
      sql`(${bot_memory_impression_scans.document_id} is null or ${bot_memory_impression_scans.content_hash} <> ${bot_memory_documents.content_hash})`,
    ))
    .orderBy(desc(bot_memory_documents.occurred_at))
    .limit(Math.max(1, Math.min(50, limit)));
  return rows.map((row) => ({
    ...row,
    sourceType: row.sourceType as BotMemorySourceType,
  }));
}

/**
 * 本文ハッシュが同じ場合だけ抽出結果を確定し、編集との競合で古い結果を残さない。
 *
 * **印象語は public な文書からしか作らない。** 印象語は日次予定表・定期ポスト・
 * bot-tan.com のダッシュボードへ流れるので、こっそり由来を1件でも入れると公開側へ漏れる。
 * 判定は呼び出し側ではなく**このトランザクションの中で対象行の visibility を読んで**行う。
 * 入口フィルタと違って、将来の呼び出し側から回避できない。
 *
 * salience（印象度）は可視範囲に関係なく保存する。こちらは公開出力へ出ず、
 * 「本人がこっそりで話しているときに、その人自身の思い出へ触れてよいか」の判定にしか
 * 使わないため。
 */
export async function saveBotMemoryImpressions(
  documentId: number,
  contentHash: string,
  impressions: BotMemoryImpressionInput[],
  salience?: number | null,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [document] = await tx
      .select({
        contentHash: bot_memory_documents.content_hash,
        visibility: bot_memory_documents.visibility,
      })
      .from(bot_memory_documents)
      .where(and(
        eq(bot_memory_documents.id, documentId),
        eq(bot_memory_documents.content_hash, contentHash),
        isNull(bot_memory_documents.deleted_at),
      ))
      .limit(1);
    if (!document) return false;

    await tx
      .delete(bot_memory_impressions)
      .where(eq(bot_memory_impressions.document_id, documentId));
    // 公開文書のときだけ印象語を残す。こっそりからは1件も作らない。
    if (impressions.length > 0 && document.visibility === "public") {
      await tx.insert(bot_memory_impressions).values(impressions.map((item) => ({
        document_id: documentId,
        kind: item.kind,
        label: item.label,
        relation: item.relation,
      })));
    }
    if (salience !== undefined) {
      await tx
        .update(bot_memory_documents)
        .set({ salience: clampSalience(salience) })
        .where(eq(bot_memory_documents.id, documentId));
    }
    await tx
      .insert(bot_memory_impression_scans)
      .values({ document_id: documentId, content_hash: contentHash })
      .onConflictDoUpdate({
        target: bot_memory_impression_scans.document_id,
        set: { content_hash: contentHash, scanned_at: new Date() },
      });
    return true;
  });
}

function impressionSource(sourceType: string): DailyPlanMemoryImpression["source"] {
  if (sourceType.startsWith("nagi_")) return "nagi";
  if (sourceType === "youtube_live_comment") return "youtube";
  return "bsky";
}

/** timestamp列のencoderを必ず通し、postgres.jsへ生のDateを渡さない。 */
export function dailyPlanImpressionCooldownCondition(cooldown: Date) {
  return or(
    isNull(bot_memory_impressions.last_used_at),
    lt(bot_memory_impressions.last_used_at, cooldown),
  );
}

/**
 * daily plan 用。削除済み原文を除き、半年以内かつ14日間未使用の候補を返す。
 *
 * **label 単位に畳んでから引く。** impressions は document ごとに保存するので、
 * 同じ話題が会話に出るたび行が増える（実測で「艦これ」だけ 2459行中199行）。
 * 畳まずに occurred_at の新しい順で8件引くと、候補が丸ごと同じ話題で埋まり、
 * 予定表が毎日その話になる。代表は会話がいちばん新しい行。
 */
export async function getDailyPlanMemoryImpressions(
  now = new Date(),
  limit = 8,
): Promise<DailyPlanMemoryImpression[]> {
  const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const cooldown = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const labelKey = sql`lower(${bot_memory_impressions.label})`;
  const unique = db
    .selectDistinctOn([labelKey], {
      id: bot_memory_impressions.id,
      kind: bot_memory_impressions.kind,
      label: bot_memory_impressions.label,
      relation: bot_memory_impressions.relation,
      sourceType: bot_memory_documents.source_type,
      occurredAt: bot_memory_documents.occurred_at,
    })
    .from(bot_memory_impressions)
    .innerJoin(
      bot_memory_documents,
      eq(bot_memory_documents.id, bot_memory_impressions.document_id),
    )
    .innerJoin(
      bot_memory_impression_scans,
      eq(bot_memory_impression_scans.document_id, bot_memory_documents.id),
    )
    .where(and(
      isNull(bot_memory_documents.deleted_at),
      // 抽出済みの後で本文がこっそりへ変わることがある（applyMutation が visibility を
      // 付け替える）。impressions 行は残るので、公開出力側でももう一度弾く。
      eq(bot_memory_documents.visibility, "public"),
      eq(bot_memory_impression_scans.content_hash, bot_memory_documents.content_hash),
      gte(bot_memory_documents.occurred_at, since),
      dailyPlanImpressionCooldownCondition(cooldown),
    ))
    // DISTINCT ON は先頭が畳む式でないと通らない。新しさで代表を決めるのが第2キー
    .orderBy(labelKey, desc(bot_memory_documents.occurred_at))
    .as("unique_impressions");

  const rows = await db
    .select()
    .from(unique)
    .orderBy(desc(unique.occurredAt))
    .limit(Math.max(1, Math.min(20, limit)));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as BotMemoryImpressionKind,
    label: row.label,
    relation: row.relation as BotMemoryImpressionRelation,
    source: impressionSource(row.sourceType),
    occurredAt: row.occurredAt,
  }));
}

/**
 * bot-tan.com 用。daily plan のクールダウンや使用済み更新とは独立して、
 * 現在も有効な公開会話の話題を会話日時の新しい順で返す。
 */
export async function getRecentBotMemoryImpressions(
  limit = 20,
): Promise<RecentBotMemoryImpression[]> {
  const clampedLimit = Math.max(1, Math.min(50, limit));
  const rows = await db
    .select({
      label: bot_memory_impressions.label,
      spokenForm: bot_memory_pronunciations.spoken_form,
      pronunciationStatus: bot_memory_pronunciations.status,
      occurredAt: bot_memory_documents.occurred_at,
    })
    .from(bot_memory_impressions)
    .innerJoin(
      bot_memory_documents,
      eq(bot_memory_documents.id, bot_memory_impressions.document_id),
    )
    .innerJoin(
      bot_memory_impression_scans,
      eq(bot_memory_impression_scans.document_id, bot_memory_documents.id),
    )
    .leftJoin(
      bot_memory_pronunciations,
      eq(bot_memory_pronunciations.surface, bot_memory_impressions.label),
    )
    .where(and(
      isNull(bot_memory_documents.deleted_at),
      // bot-tan.com が公開するので、抽出後にこっそりへ変わった分もここで弾く。
      eq(bot_memory_documents.visibility, "public"),
      inArray(bot_memory_documents.source_type, IMPRESSION_SOURCE_TYPES),
      eq(bot_memory_impression_scans.content_hash, bot_memory_documents.content_hash),
    ))
    .orderBy(desc(bot_memory_documents.occurred_at), desc(bot_memory_impressions.id))
    // 重複が多い会話でも20種類に届きやすいよう、表示数より広めに読む。
    .limit(clampedLimit * 10);
  return selectRecentBotMemoryImpressions(rows, clampedLimit);
}

export async function markDailyPlanMemoryImpressionsUsed(
  ids: number[],
  usedAt = new Date(),
) {
  const unique = [...new Set(ids.filter(Number.isInteger))];
  if (unique.length === 0) return;
  await db
    .update(bot_memory_impressions)
    .set({ last_used_at: usedAt })
    .where(inArray(bot_memory_impressions.id, unique));
}

type RankedRow = Omit<BotMemorySearchResult, "relevance" | "semanticRank" | "lexicalRank">;

/**
 * RRFは異なる尺度のsemantic/lexical scoreを直接足さず、順位だけを安定して統合する。
 *
 * `weight` は複数の検索レグ（本人の記憶 / 全体の記憶）を1つの順位表へ畳むときに使う。
 * 既定は 1 なので、単一レグの呼び出しの挙動は変わらない。
 */
export function mergeBotMemoryRanks(
  semanticRows: RankedRow[],
  lexicalRows: RankedRow[],
  limit: number,
  k = 60,
  weight = 1,
): BotMemorySearchResult[] {
  const merged = new Map<number, BotMemorySearchResult>();
  addBotMemoryRanks(merged, semanticRows, lexicalRows, k, weight);
  return finalizeBotMemoryRanks(merged, limit);
}

/**
 * 重み付きの多レグRRF。
 *
 * 「そのユーザーに関連する記憶が強めの係数で出る（ただし他をフィルタしない）」を
 * 実現する土台。本人レグを weight > 1 で、全体レグを weight = 1 で同じ表へ積む。
 * ハードフィルタ（searchConditions の authorId）と違い、本人の記憶が無くても
 * 全体の記憶は残る。
 */
export function addBotMemoryRanks(
  merged: Map<number, BotMemorySearchResult>,
  semanticRows: RankedRow[],
  lexicalRows: RankedRow[],
  k = 60,
  weight = 1,
) {
  const add = (row: RankedRow, rank: number, kind: "semantic" | "lexical") => {
    const current = merged.get(row.id) ?? { ...row, relevance: 0 };
    current.relevance += weight / (k + rank);
    // 複数レグで同じ文書が出たときは、より上位の順位を残す。劣化時ガード
    // （selectReplyMemoryContext の semanticRank 判定）が弱まらないようにする。
    if (kind === "semantic") {
      current.semanticRank = Math.min(current.semanticRank ?? rank, rank);
    } else {
      current.lexicalRank = Math.min(current.lexicalRank ?? rank, rank);
    }
    merged.set(row.id, current);
  };
  semanticRows.forEach((row, i) => add(row, i + 1, "semantic"));
  lexicalRows.forEach((row, i) => add(row, i + 1, "lexical"));
  return merged;
}

export function finalizeBotMemoryRanks(
  merged: Map<number, BotMemorySearchResult>,
  limit: number,
): BotMemorySearchResult[] {
  return [...merged.values()]
    .sort((a, b) => b.relevance - a.relevance || b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, limit);
}

/**
 * 可視範囲の条件。**許可を足す形**で組む。
 *
 * 既定は public だけ。こっそりの文脈にいる本人の subjectKey が渡されたときに限り、
 * 「その人自身のこっそり記憶」を候補へ足す。他人のこっそりは author_id が一致しないので
 * どの文脈でも出ない。逆に、通常投稿の文脈ではこっそりが1件も混ざらない。
 */
export function visibilityCondition(scope: BotMemoryScope) {
  const publicOnly = eq(bot_memory_documents.visibility, "public");
  if (!scope.kossoriSubjectKey) return publicOnly;
  return or(
    publicOnly,
    and(
      eq(bot_memory_documents.visibility, "kossori"),
      eq(bot_memory_documents.author_id, scope.kossoriSubjectKey),
    ),
  )!;
}

/** export しているのは、可視範囲がどの検索にも必ず入ることをテストで固定するため。 */
export function searchConditions(request: BotMemorySearchRequest) {
  const activeSources = activeBotMemorySourceTypes(request.sources);
  return [
    isNull(bot_memory_documents.deleted_at),
    visibilityCondition(request),
    activeSources.length
      ? inArray(bot_memory_documents.source_type, activeSources)
      : sql`false`,
    ...(request.authorId ? [eq(bot_memory_documents.author_id, request.authorId)] : []),
    ...(request.excludeAuthorId ? [ne(bot_memory_documents.author_id, request.excludeAuthorId)] : []),
    ...(request.since ? [gte(bot_memory_documents.occurred_at, request.since)] : []),
    ...(request.until ? [lt(bot_memory_documents.occurred_at, request.until)] : []),
    ...(request.excludeDocumentIds?.length
      ? [notInArray(bot_memory_documents.id, request.excludeDocumentIds)]
      : []),
  ];
}

function toRanked(row: any): RankedRow {
  return {
    id: row.id,
    sourceType: row.sourceType as BotMemorySourceType,
    sourceId: row.sourceId,
    sourceUri: row.sourceUri,
    authorId: row.authorId,
    content: row.content,
    botResponse: row.botResponse,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt),
    affirmationScore: row.affirmationScore,
    salience: row.salience ?? null,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

const selection = {
  id: bot_memory_documents.id,
  sourceType: bot_memory_documents.source_type,
  sourceId: bot_memory_documents.source_id,
  sourceUri: bot_memory_documents.source_uri,
  authorId: bot_memory_documents.author_id,
  content: bot_memory_documents.content,
  botResponse: bot_memory_documents.bot_response,
  occurredAt: bot_memory_documents.occurred_at,
  affirmationScore: bot_memory_documents.affirmation_score,
  salience: bot_memory_documents.salience,
  metadata: bot_memory_documents.metadata,
};

/**
 * 1レグぶんの候補取得。マージ前の semantic / lexical をそのまま返す。
 *
 * `embedding` を受け取れるのは、複数レグを走らせるときに同じクエリを
 * 何度も埋め込み直さないため（embedSearchQuery は Ollama への往復）。
 */
export async function searchBotMemoryLegs(
  request: BotMemorySearchRequest,
  embedding: number[] | null,
  candidateLimit: number,
): Promise<{ semanticRows: RankedRow[]; lexicalRows: RankedRow[] }> {
  const query = request.query.trim();
  const base = searchConditions(request);
  const [semanticRows, lexicalRows] = await Promise.all([
    embedding
      ? (() => {
          const vec = sql`${`[${embedding.join(",")}]`}::vector`;
          return db
            .select(selection)
            .from(bot_memory_documents)
            .where(and(...base, sql`${bot_memory_documents.embedding} is not null`))
            .orderBy(sql`${bot_memory_documents.embedding} <=> ${vec}`)
            .limit(candidateLimit);
        })()
      : Promise.resolve([]),
    db
      .select(selection)
      .from(bot_memory_documents)
      .where(and(
        ...base,
        sql`(${bot_memory_documents.content} ilike ${`%${query}%`} or similarity(${bot_memory_documents.content}, ${query}) > 0.1)`,
      ))
      .orderBy(sql`similarity(${bot_memory_documents.content}, ${query}) desc`, desc(bot_memory_documents.occurred_at))
      .limit(candidateLimit),
  ]);
  return {
    semanticRows: semanticRows.map(toRanked),
    lexicalRows: lexicalRows.map(toRanked),
  };
}

export async function searchBotMemory(
  request: BotMemorySearchRequest,
  deps: { embed?: typeof embedSearchQuery } = {},
): Promise<BotMemorySearchResult[]> {
  const query = request.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(20, request.limit ?? 10));
  const candidateLimit = Math.max(30, limit * 3);
  // 検索クエリなので接頭辞を付ける側（文書の埋め込みは botMemoryEmbeddingWorker が
  // generateEmbeddings で行う）。instruction-aware なモデルではここが精度を左右する。
  const embedding = await (deps.embed ?? embedSearchQuery)(query);
  const { semanticRows, lexicalRows } = await searchBotMemoryLegs(
    request,
    embedding,
    candidateLimit,
  );
  return mergeBotMemoryRanks(semanticRows, lexicalRows, limit);
}

export async function recordBotMemoryUsages(
  documentIds: number[],
  purpose: BotMemoryPurpose,
  outputRef?: string,
) {
  const uniqueIds = [...new Set(documentIds.filter(Number.isInteger))];
  if (!uniqueIds.length) return;
  await db.insert(bot_memory_usages).values(uniqueIds.map((documentId) => ({
    document_id: documentId,
    purpose,
    output_ref: outputRef ?? null,
  })));
}

export async function getRecentlyUsedBotMemoryDocumentIds(
  purpose: BotMemoryPurpose,
  since: Date,
) {
  const rows = await db
    .select({ documentId: bot_memory_usages.document_id })
    .from(bot_memory_usages)
    .where(and(
      eq(bot_memory_usages.purpose, purpose),
      gte(bot_memory_usages.used_at, since),
    ));
  return [...new Set(rows.map((row) => row.documentId))];
}

// ---------------------------------------------------------------------------
// 短期記憶: 日次ダイジェスト
//
// 「直近に何があったか」はベクトル検索で引かない。クエリに似ていなければ
// 出てこない = 直近の出来事を忘れる、という穴になるため。ここは時間で引き、
// 検索結果とは独立に常時プロンプトへ載せる。
// ---------------------------------------------------------------------------

export interface MemoryDigestHighlight {
  documentId: number;
  excerpt: string;
  surface: "bsky" | "nagi" | "youtube";
}

export interface MemoryDailyDigest {
  digestDate: string;
  summaryJa: string;
  highlights: MemoryDigestHighlight[];
  sourceCount: number;
}

/** JST の "YYYY-MM-DD"。daily_metrics と同じ日付表現に揃える。 */
export function memoryDigestDate(at: Date): string {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" の JST 一日ぶんを UTC の [from, to) へ開く。 */
export function memoryDigestDayRange(digestDate: string): { from: Date; to: Date } {
  const from = new Date(`${digestDate}T00:00:00+09:00`);
  if (!Number.isFinite(from.getTime())) throw new Error(`invalid digest date: ${digestDate}`);
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

function toDigest(row: {
  digestDate: string;
  summaryJa: string;
  highlights: unknown;
  sourceCount: number;
}): MemoryDailyDigest {
  return {
    digestDate: row.digestDate,
    summaryJa: row.summaryJa,
    highlights: Array.isArray(row.highlights)
      ? (row.highlights as MemoryDigestHighlight[])
      : [],
    sourceCount: row.sourceCount,
  };
}

const digestSelection = {
  digestDate: bot_memory_daily_digests.digest_date,
  summaryJa: bot_memory_daily_digests.summary_ja,
  highlights: bot_memory_daily_digests.highlights,
  sourceCount: bot_memory_daily_digests.source_count,
};

/** 新しい順。既定は1週間ぶん。 */
export async function getRecentMemoryDigests(
  days = 7,
  now = new Date(),
): Promise<MemoryDailyDigest[]> {
  const limit = Math.max(1, Math.min(30, days));
  // 日付は text なので、境界日を計算して文字列比較する（timestamp encoder を経由しない）。
  const since = memoryDigestDate(new Date(now.getTime() - limit * 24 * 60 * 60 * 1000));
  const rows = await db
    .select(digestSelection)
    .from(bot_memory_daily_digests)
    .where(gte(bot_memory_daily_digests.digest_date, since))
    .orderBy(desc(bot_memory_daily_digests.digest_date))
    .limit(limit);
  return rows.map(toDigest);
}

export async function getMemoryDailyDigest(
  digestDate: string,
): Promise<MemoryDailyDigest | null> {
  const [row] = await db
    .select(digestSelection)
    .from(bot_memory_daily_digests)
    .where(eq(bot_memory_daily_digests.digest_date, digestDate))
    .limit(1);
  return row ? toDigest(row) : null;
}

export async function upsertMemoryDailyDigest(input: {
  digestDate: string;
  summaryJa: string;
  highlights?: MemoryDigestHighlight[];
  sourceCount?: number;
}): Promise<void> {
  const summary = input.summaryJa.trim();
  if (!summary) return;
  const values = {
    summary_ja: summary,
    highlights: input.highlights ?? [],
    source_count: input.sourceCount ?? 0,
    updated_at: new Date(),
  };
  await db
    .insert(bot_memory_daily_digests)
    .values({ digest_date: input.digestDate, ...values })
    .onConflictDoUpdate({
      target: bot_memory_daily_digests.digest_date,
      set: values,
    });
}

/** ダイジェスト生成の素材。1日ぶんを古い順に返す。 */
export async function getMemoryDocumentsForDay(
  digestDate: string,
  limit = 60,
): Promise<BotMemorySearchResult[]> {
  const { from, to } = memoryDigestDayRange(digestDate);
  const rows = await db
    .select(selection)
    .from(bot_memory_documents)
    .where(and(
      isNull(bot_memory_documents.deleted_at),
      // ダイジェストは誰への返信でも常時プロンプトへ載る＝実質公開。こっそりは入れない。
      eq(bot_memory_documents.visibility, "public"),
      inArray(bot_memory_documents.source_type, [...BOT_MEMORY_ACTIVE_SOURCE_TYPES]),
      gte(bot_memory_documents.occurred_at, from),
      lt(bot_memory_documents.occurred_at, to),
    ))
    .orderBy(bot_memory_documents.occurred_at)
    .limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({ ...toRanked(row), relevance: 0 }));
}

// ---------------------------------------------------------------------------
// 統合記憶コンテキスト
// ---------------------------------------------------------------------------

export interface MemoryContextRequest extends BotMemoryScope {
  query: string;
  purpose: BotMemoryPurpose;
  /**
   * 記憶を強めたい相手。`did:plc:...` または `youtube:<channelId>`。
   *
   * **フィルタではなく係数。** 指定しても他の人の記憶は落ちない。本人レグを
   * `subjectWeight` 倍して同じ順位表へ積むだけなので、その人との記憶が
   * 無くても全体の記憶は今まで通り返る。
   */
  subjectKey?: string;
  /** 本人レグの係数。既定 2。1 にすると重み無しと同じ。 */
  subjectWeight?: number;
  sources?: BotMemorySourceType[];
  excludeAuthorIds?: (string | undefined)[];
  excludeDocumentIds?: number[];
  limit?: number;
  /** 短期記憶に載せる日数。0 で無効。 */
  digestDays?: number;
  /** 外部から仕入れた事実。思い出の枠を食わせないので別枠で返す。 */
  researchLimit?: number;
  /**
   * 「お友達の話」に使ってよい source。既定は肯定した投稿だけ。
   *
   * 他人の記憶を紹介する経路なので、botたんが実際に肯定した公開投稿に限る。
   * related の候補（全体レグ）自体は絞らない。ここで絞るのは friend の選抜だけ。
   */
  friendSources?: BotMemorySourceType[];
}

/**
 * HTTP 経由で受け付ける範囲。
 *
 * `kossoriSubjectKey` は**意図的に外してある**。内部シークレットを持つ相手なら誰でも
 * 任意の人のこっそり記憶を引ける口になってしまう。こっそりの範囲を決めてよいのは、
 * その返信がこっそりスレッドかを AppView の行で確かめられる TS 側の呼び出しだけ。
 * `excludeAuthorIds` も内部呼び出し専用。
 */
export type BotMemoryContextRequestBody =
  Omit<MemoryContextRequest, "excludeAuthorIds" | "kossoriSubjectKey">;

export interface MemoryContext {
  /** 短期記憶。検索を通していない、時間で引いた直近の出来事。 */
  recent: MemoryDailyDigest[];
  /**
   * subjectKey 本人の記憶だけ。
   *
   * **related と混ぜてはいけない。** リプライ生成では「その人自身の過去の投稿」
   * として扱われるスロットへ入るので、他人の記憶が紛れると本人が言っていない
   * ことを言ったことにしてしまう。
   */
  own: BotMemorySearchResult[];
  /**
   * 本人レグを重み付けして全体レグと畳んだ順位表。
   *
   * 「その人に関連する記憶が強めに出る。ただし他をフィルタしない」という
   * 統合APIの契約はこれ。誰の記憶かを区別しない用途（配信の話題出しなど）向け。
   */
  related: BotMemorySearchResult[];
  /** 他の人の記憶から1件だけ。劣化時ガードを通したもの。 */
  friend?: BotMemorySearchResult;
  /**
   * 「この前の話」として触れてよい、その人自身の思い出。最大1件。
   *
   * 触れるかどうかをプロンプトの条件分岐で決めない。肯定リプライには既に
   * 「過去のポストに直接言及するな」という明示的な禁止があり、そこへ
   * 「感情が動いているときだけ触れて」を足すとルールが矛盾する。
   * **条件を満たすときだけここに1件入り、無い日は節ごとプロンプトに出ない。**
   */
  notable?: BotMemorySearchResult;
  /** web_research。related とは別枠。 */
  research: BotMemorySearchResult[];
}

const DEFAULT_SUBJECT_WEIGHT = 2;

/**
 * 「この前の話」に触れてよいと判断する印象度の下限。
 *
 * botMemoryImpressions のプロンプトでは 80 以上が「本人にとって大きな出来事」。
 * ここを下げると、挨拶や近況にまで昔話を持ち出すようになる。
 */
const NOTABLE_SALIENCE_MIN = 70;

/**
 * 思い出として渡してよい1件を選ぶ。
 *
 * - 本人の記憶（own レグ）からしか選ばない
 * - 印象度が閾値以上
 * - `semanticRank !== undefined` ＝ 意味的に今回の話と繋がっている。
 *   語彙一致だけの偶然（同じ単語がたまたま出た）で昔話を始めさせない。
 *   embedding 障害時は lexical だけになるので、そのときは何も返さないのが正しい
 * - 同じ話を毎回持ち出さないよう、直近で使ったものは呼び出し側が
 *   excludeDocumentIds で外せる
 *
 * 最大1件。供給量で制御するので、プロンプトに水増しの余地を作らない。
 */
export function selectNotableMemory(
  ownRows: BotMemorySearchResult[],
  minSalience = NOTABLE_SALIENCE_MIN,
): BotMemorySearchResult | undefined {
  const candidates = ownRows.filter((row) =>
    row.semanticRank !== undefined &&
    row.salience !== null &&
    row.salience >= minSalience
  );
  if (candidates.length === 0) return undefined;
  // 印象の強い順。同点なら今回の話に近い順（relevance）。
  return [...candidates].sort(
    (a, b) => (b.salience! - a.salience!) || (b.relevance - a.relevance),
  )[0];
}

/**
 * 思い出レグの既定 source。web_research を外す。
 *
 * web_research は「誰かとのやりとりの記憶」ではなく外部から仕入れた知識なので、
 * 混ぜると related の枠を事実の羅列が食う。別レグで independent に返す。
 */
/** お友達の紹介に使う source。botたんが肯定した公開投稿だけ。 */
export const DEFAULT_FRIEND_SOURCE_TYPES: BotMemorySourceType[] = [
  "bsky_affirmed_post",
  "nagi_affirmed_post",
];

export const RECOLLECTION_SOURCE_TYPES: BotMemorySourceType[] =
  BOT_MEMORY_ACTIVE_SOURCE_TYPES.filter((sourceType) => sourceType !== "web_research");

/**
 * 三層をまとめて取り出す。
 *
 * - recent: 時間で引く（検索しない）。**常に public のみ**
 * - related / friend: ベクトル+全文のハイブリッド検索。subjectKey は係数で効かせる
 * - research: 外部知識。思い出の枠と混ぜない
 *
 * こっそりは `kossoriSubjectKey` を渡したときだけ、その人自身の分が候補へ入る。
 * 通常投稿の文脈（未指定）では1件も混ざらない。
 *
 * 記憶基盤の障害で呼び出し元の返信生成を巻き戻さないよう、各レグは個別に握り潰す。
 */
export async function buildMemoryContext(
  request: MemoryContextRequest,
  deps: { embed?: typeof embedSearchQuery } = {},
): Promise<MemoryContext> {
  const query = request.query.trim();
  const limit = Math.max(1, Math.min(20, request.limit ?? 10));
  const candidateLimit = Math.max(30, limit * 3);
  const digestDays = request.digestDays ?? 7;
  const researchLimit = request.researchLimit ?? 3;
  const subjectWeight = request.subjectWeight ?? DEFAULT_SUBJECT_WEIGHT;

  const recentPromise = digestDays > 0
    ? getRecentMemoryDigests(digestDays).catch((error) => {
        console.warn("[WARN][BOT_MEMORY] daily digest lookup failed", error);
        return [] as MemoryDailyDigest[];
      })
    : Promise.resolve([] as MemoryDailyDigest[]);

  if (!query) {
    return { recent: await recentPromise, own: [], related: [], research: [] };
  }

  const embedding = await (deps.embed ?? embedSearchQuery)(query).catch((error) => {
    // 埋め込みが落ちても lexical だけで続ける。friend の誤紹介は
    // selectReplyMemoryContext の semanticRank ガードが引き続き防ぐ。
    console.warn("[WARN][BOT_MEMORY] query embedding failed; lexical only", error);
    return null;
  });

  const leg = (
    overrides: Partial<BotMemorySearchRequest>,
    label: string,
  ) =>
    searchBotMemoryLegs(
      {
        query,
        purpose: request.purpose,
        sources: request.sources ?? RECOLLECTION_SOURCE_TYPES,
        excludeDocumentIds: request.excludeDocumentIds,
        limit,
        // こっそりの範囲は全レグへ同じものを配る。全体レグは excludeAuthorId で
        // 本人以外に絞られるため、他人のこっそりはそもそも一致しない。
        kossoriSubjectKey: request.kossoriSubjectKey,
        ...overrides,
      },
      embedding,
      candidateLimit,
    ).catch((error) => {
      console.warn(`[WARN][BOT_MEMORY] ${label} leg failed`, error);
      return { semanticRows: [] as RankedRow[], lexicalRows: [] as RankedRow[] };
    });

  const [recent, subjectLeg, globalLeg, researchLeg] = await Promise.all([
    recentPromise,
    request.subjectKey
      ? leg({ authorId: request.subjectKey }, "subject")
      : Promise.resolve({ semanticRows: [] as RankedRow[], lexicalRows: [] as RankedRow[] }),
    leg(
      request.subjectKey ? { excludeAuthorId: request.subjectKey } : {},
      "global",
    ),
    researchLimit > 0
      ? leg({ sources: ["web_research"], limit: researchLimit }, "research")
      : Promise.resolve({ semanticRows: [] as RankedRow[], lexicalRows: [] as RankedRow[] }),
  ]);

  const merged = new Map<number, BotMemorySearchResult>();
  addBotMemoryRanks(merged, subjectLeg.semanticRows, subjectLeg.lexicalRows, 60, subjectWeight);
  addBotMemoryRanks(merged, globalLeg.semanticRows, globalLeg.lexicalRows, 60, 1);
  const related = finalizeBotMemoryRanks(merged, limit);

  const own = finalizeBotMemoryRanks(
    addBotMemoryRanks(
      new Map<number, BotMemorySearchResult>(),
      subjectLeg.semanticRows,
      subjectLeg.lexicalRows,
    ),
    limit,
  );

  const globalRanked = finalizeBotMemoryRanks(
    addBotMemoryRanks(
      new Map<number, BotMemorySearchResult>(),
      globalLeg.semanticRows,
      globalLeg.lexicalRows,
    ),
    limit,
  );
  const friendSources = new Set<BotMemorySourceType>(
    request.friendSources ?? DEFAULT_FRIEND_SOURCE_TYPES,
  );
  const { friendMemory } = selectReplyMemoryContext(
    [],
    globalRanked.filter((row) => friendSources.has(row.sourceType)),
    [request.subjectKey, ...(request.excludeAuthorIds ?? [])],
  );

  const research = finalizeBotMemoryRanks(
    addBotMemoryRanks(
      new Map<number, BotMemorySearchResult>(),
      researchLeg.semanticRows,
      researchLeg.lexicalRows,
    ),
    Math.max(1, researchLimit),
  );

  return {
    recent,
    own,
    related,
    friend: friendMemory,
    notable: selectNotableMemory(own),
    research,
  };
}
