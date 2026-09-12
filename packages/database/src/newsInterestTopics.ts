/**
 * 全肯定ニュースの取得を、botたんが覚えた嗜好へ寄せるための読み書き。
 *
 * 素材は bot_memory_impressions（会話から抽出した作品名・固有名詞）。ジャンルへの
 * 一般化そのものは bot-brain の generalizeInterestLabels が担当し、ここは
 * 「数えて渡す」「結果を置く」「次に使うジャンルを1つ配る」だけを持つ。
 */
import { and, desc, eq, gte, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  bot_memory_documents,
  bot_memory_impression_scans,
  bot_memory_impressions,
  db,
} from "./db.js";
import { nagiNewsInterestTopics } from "./nagiSchema.js";

/** 関心を数える窓。これより古い会話は嗜好として扱わない。 */
export const INTEREST_LABEL_WINDOW_DAYS = 90;

/**
 * 印象語の重み。「おすすめされた」ほど嗜好の表明として強い。
 * 単なる話題（discussed）も数えるが、1票ぶんにとどめる。
 */
const RELATION_WEIGHT = sql<number>`sum(case ${bot_memory_impressions.relation}
  when 'recommended' then 3 when 'liked' then 2 else 1 end)::int`;

export interface BotMemoryInterestLabel {
  label: string;
  weight: number;
}

/**
 * 印象語を label 単位に畳んで、重みの大きい順に返す。
 *
 * - **label 単位に畳む。** impressions は document ごとに積まれるので、同じ作品名が
 *   会話のたびに行を増やす。畳まないと1作品が上位を埋めてジャンルが1つしか出ない。
 * - **公開の会話だけを数える。** こっそりの中身は公開出力へ出さない、という他の
 *   読み手（getDailyPlanMemoryImpressions / getRecentBotMemoryImpressions）と揃える。
 *   ジャンルまで一般化すれば個人は特定できないが、例外を1つ作るとその根拠を
 *   あとから誰も確認できなくなる。
 * - 抽出後に本文がこっそりへ付け替わった行も content_hash の突き合わせで落とす。
 */
export async function loadBotMemoryInterestLabels(input: {
  now?: Date;
  limit?: number;
} = {}): Promise<BotMemoryInterestLabel[]> {
  const now = input.now ?? new Date();
  const since = new Date(
    now.getTime() - INTEREST_LABEL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const limit = Math.max(1, Math.min(500, input.limit ?? 120));
  const rows = await db
    .select({
      label: sql<string>`max(${bot_memory_impressions.label})`,
      weight: RELATION_WEIGHT,
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
      eq(bot_memory_documents.visibility, "public"),
      eq(bot_memory_impression_scans.content_hash, bot_memory_documents.content_hash),
      gte(bot_memory_documents.occurred_at, since),
    ))
    .groupBy(sql`lower(${bot_memory_impressions.label})`)
    .orderBy(desc(RELATION_WEIGHT), sql`lower(${bot_memory_impressions.label}) asc`)
    .limit(limit);
  return rows.map((row) => ({ label: row.label, weight: Number(row.weight) }));
}

export interface NewsInterestTopicInput {
  topic: string;
  score: number;
  labelCount: number;
}

/**
 * 関心ジャンルを総入れ替えする。
 *
 * **last_used_at は持ち越す。** 入れ替えのたびに消すと、毎回スコア最上位のジャンルが
 * 選ばれ続けて取得が1ジャンルに張り付く。ジャンルの顔ぶれが変わっても「最近使ったか」
 * は同じ意味を持ち続けるので、更新では触らない。
 */
export async function replaceNewsInterestTopics(
  topics: NewsInterestTopicInput[],
  now = new Date(),
): Promise<number> {
  const rows = topics
    .filter((item) => item.topic.trim())
    .map((item) => ({
      topic: item.topic,
      score: Math.max(0, Math.round(item.score)),
      labelCount: Math.max(0, Math.round(item.labelCount)),
      updatedAt: now,
    }));
  await db.transaction(async (tx) => {
    await tx
      .delete(nagiNewsInterestTopics)
      .where(
        rows.length
          ? notInArray(nagiNewsInterestTopics.topic, rows.map((row) => row.topic))
          : undefined,
      );
    if (!rows.length) return;
    await tx
      .insert(nagiNewsInterestTopics)
      .values(rows)
      .onConflictDoUpdate({
        target: nagiNewsInterestTopics.topic,
        set: {
          score: sql`excluded.score`,
          labelCount: sql`excluded.label_count`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });
  return rows.length;
}

/** 関心ジャンルを最後に作り直した時刻。TTL 判定に使う。行が無ければ undefined。 */
export async function newsInterestTopicsRefreshedAt(): Promise<Date | undefined> {
  const rows = await db
    .select({ updatedAt: sql<Date | null>`max(${nagiNewsInterestTopics.updatedAt})` })
    .from(nagiNewsInterestTopics);
  const value = rows[0]?.updatedAt;
  return value ? new Date(value) : undefined;
}

export interface PickedNewsInterestTopic {
  topic: string;
  score: number;
}

/**
 * 次の取得に使うジャンルを1つ配り、使用印を付ける。
 *
 * スコア順のままだと最上位だけを引き続けるので、クールダウン内のジャンルは候補から
 * 外す。4スロット/日に対して既定24時間なら、上位から日替わりで回る形になる。
 * 全ジャンルがクールダウン中なら undefined ＝ 従来どおりの無指定取得へ落ちる。
 *
 * 使用印は配った時点で付ける。取得が失敗したジャンルもクールダウンへ入るので、
 * 30分後の再試行が同じジャンルを叩き続けることにはならない。
 */
export async function pickNewsInterestTopic(input: {
  now?: Date;
  cooldownMs?: number;
} = {}): Promise<PickedNewsInterestTopic | undefined> {
  const now = input.now ?? new Date();
  const cooldown = new Date(now.getTime() - (input.cooldownMs ?? 24 * 60 * 60 * 1000));
  const candidates = await db
    .select({ topic: nagiNewsInterestTopics.topic, score: nagiNewsInterestTopics.score })
    .from(nagiNewsInterestTopics)
    .where(or(
      isNull(nagiNewsInterestTopics.lastUsedAt),
      lt(nagiNewsInterestTopics.lastUsedAt, cooldown),
    ))
    .orderBy(desc(nagiNewsInterestTopics.score), nagiNewsInterestTopics.topic)
    .limit(1);
  const picked = candidates[0];
  if (!picked) return undefined;
  await db
    .update(nagiNewsInterestTopics)
    .set({ lastUsedAt: now, lastAcceptedCount: null })
    .where(eq(nagiNewsInterestTopics.topic, picked.topic));
  return { topic: picked.topic, score: picked.score };
}

/** そのジャンルで何件が粗選別を通ったかを残す。空振りが続くジャンルの発見用。 */
export async function recordNewsInterestTopicYield(
  topic: string,
  acceptedCount: number,
): Promise<void> {
  await db
    .update(nagiNewsInterestTopics)
    .set({ lastAcceptedCount: Math.max(0, Math.round(acceptedCount)) })
    .where(eq(nagiNewsInterestTopics.topic, topic));
}
