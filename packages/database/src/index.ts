import {
  db,
  client,
  initializeDatabases,
  bot_state,
  followers,
  posts,
  likes,
  replies,
  affirmations,
  interaction,
  subscribers,
  biorhythm_history,
  gifts,
  room_events,
  youtube_shorts,
  nagiActors,
  nagiPosts,
  nagiPostScores,
  nagiProfiles,
  nagiReactions,
  nagiChannels,
  nagiAnalysisJobs,
  nagiPreferredNames,
  daily_metrics,
  repo_write_points,
  bot_memory_documents,
  bot_memory_impressions,
  bot_memory_impression_scans,
  bot_memory_pronunciations,
  bot_memory_pronunciation_scans,
  bot_memory_usages,
} from './db.js';
import { eq, desc, sql, gte, lte, and, gt, inArray, lt, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { generateEmbedding } from './ollamaEmbed.js';
import { tryUpsertBotMemoryDocument } from './botMemory.js';
import { LanguageName, LIMIT_REQUEST_PER_DAY_GEMINI, DailyReport, Stats } from '@bsky-affirmative-bot/shared-configs';

export { initializeDatabases, db, client, subscribers, followers };
// affirmative_bot スキーマの生テーブル。名前が汎用的すぎて nagi 側と紛らわしいので bot* に
// 揃えて出す。Nagi の退会処理が「Nagi 由来の行だけ」を消すために必要。
export {
  posts as botPosts,
  likes as botLikes,
  replies as botReplies,
  interaction as botInteraction,
  affirmations as botAffirmations,
  bot_memory_documents,
  bot_memory_impressions,
  bot_memory_impression_scans,
  bot_memory_pronunciations,
  bot_memory_pronunciation_scans,
  bot_memory_usages,
};
export * from './nagiSchema.js';
export * from './health.js';
export * from './botMemory.js';
export * from './botMemoryPronunciation.js';
export { filterRelatedHistory, generateEmbedding, generateEmbeddings } from './ollamaEmbed.js';
export type { DailyReport, Stats };

/**
 * 「きょうのおすすめ投稿」。Bluesky は URI だけ返し、本文とアバターはサイト側が
 * public.api.bsky.app から取る。Nagi は公開 AppView 越しに取れないので、表示に
 * 必要なぶんをここで一緒に返す。
 */
export interface TopPost {
  uri: string;
  comment: string;
  network: 'bsky' | 'nagi';
  score: number;
  text?: string;
  createdAt?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatarCid?: string;
  authorDid?: string;
  rkey?: string;
}

/** お部屋で起きた1件のできごと。 */
export interface RoomEvent {
  id: number;
  did: string;
  /** "gift" | "chat" | "greeting" */
  type: string;
  /** ユーザー入力由来。プロンプトに載せる際はデータとして扱うこと。 */
  detail: string | null;
  created_at: Date;
}

/** 日次おすすめ選出Providerが解決前に受け取る、ネットワーク共通の候補行。 */
export interface DailyTopPostCandidateRow {
  network: 'bsky' | 'nagi';
  uri: string;
  cid?: string;
  text: string;
  comment: string;
  score: number;
  createdAt: Date;
  did: string;
  handle?: string;
  displayName?: string;
  avatarCid?: string;
  rkey?: string;
}

/** bot-tan.com のダッシュボードの Nagi カラムが必要とする数値。 */
export interface NagiStats {
  totalUsers: number;
  usersAddedYesterday: number;
  totalReactions: number;
  totalPosts: number;
  totalChannels: number;
}

/** bottan_live.comments の本文を持ち出さずに返す、energy 同期用の集計。 */
export interface LiveCommentBatch {
  count: number;
  maxId: number | null;
}

export interface YoutubeLiveBroadcast {
  broadcastId: string;
  url: string;
  title: string | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function getYoutubeLivePromotionBounds(now: Date) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  const jstMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - JST_OFFSET_MS;
  return {
    dayStart: new Date(jstMidnight),
    nextDayStart: new Date(jstMidnight + 24 * 60 * 60 * 1000),
    promotionStart: new Date(jstMidnight + 4 * 60 * 60 * 1000),
  };
}

export function isYoutubeWatchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com')
      && url.pathname === '/watch'
      && Boolean(url.searchParams.get('v'));
  } catch {
    return false;
  }
}

export type RepoWriteAction = 'create' | 'update' | 'delete';

export interface RepoWritePointUsage {
  hour: { used: number; limit: 5000; windowSeconds: 3600 };
  day: { used: number; limit: 35000; windowSeconds: 86400 };
}

const REPO_WRITE_POINTS: Record<RepoWriteAction, number> = {
  create: 3,
  update: 2,
  delete: 1,
};

export class MemoryService {
  static async getBotState(key: string): Promise<any> {
    try {
      const result = await db.select().from(bot_state).where(eq(bot_state.key, key)).limit(1);
      const row = result[0];
      if (row && typeof row.value === 'string') {
        try {
          return JSON.parse(row.value);
        } catch {
          return row.value;
        }
      }
      return row ? row.value : null;
    } catch (e) {
      console.error(`Failed to get bot state for ${key}`, e);
      return null;
    }
  }

  static async setBotState(key: string, value: any) {
    await db.insert(bot_state)
      .values({ key, value })
      .onConflictDoUpdate({
        target: bot_state.key,
        set: { value, updated_at: new Date() }
      });
  }

  static async getBiorhythmState(): Promise<any> {
    const state = await this.getBotState('biorhythm');
    return state || {};
  }

  /**
   * Live 配信DBの新規コメント件数を返す。
   * コメント本文・投稿者情報は biorhythm 側には不要なので取得しない。
   */
  static async getLiveCommentBatchAfter(afterId: number): Promise<LiveCommentBatch> {
    const rows = await db.execute<{ comment_count: string; max_id: number | null }>(sql`
      SELECT
        count(*)::text AS comment_count,
        max(id)::integer AS max_id
      FROM bottan_live.comments
      WHERE id > ${afterId}
    `);
    const row = rows[0];
    return {
      count: Number(row?.comment_count ?? 0),
      maxId: row?.max_id === null || row?.max_id === undefined
        ? null
        : Number(row.max_id),
    };
  }

  /** JST当日の気まぐれ投稿で紹介できる、終了10分前より前の配信枠。 */
  static async getTodayYoutubeLiveBroadcast(
    now = new Date(),
  ): Promise<YoutubeLiveBroadcast | null> {
    const bounds = getYoutubeLivePromotionBounds(now);
    if (now < bounds.promotionStart) return null;
    // bottan_live は Drizzle のスキーマ定義外なので、Date を raw sql へ直接渡さない。
    // postgres.js が型を推論できず ERR_INVALID_ARG_TYPE になるため、ISO 文字列を
    // timestamptz として明示する（詳細はリポジトリ直下の AGENTS.md を参照）。
    const dayStart = bounds.dayStart.toISOString();
    const nextDayStart = bounds.nextDayStart.toISOString();
    const currentTime = now.toISOString();
    try {
      const rows = await db.execute<{
        broadcast_id: string;
        url: string;
        title: string | null;
        scheduled_start_at: Date;
        scheduled_end_at: Date;
      }>(sql`
        SELECT broadcast_id, url, title, scheduled_start_at, scheduled_end_at
        FROM bottan_live.broadcasts
        WHERE scheduled_start_at >= ${dayStart}::timestamptz
          AND scheduled_start_at < ${nextDayStart}::timestamptz
          AND scheduled_end_at IS NOT NULL
          AND ${currentTime}::timestamptz < scheduled_end_at - interval '10 minutes'
          AND ended_at IS NULL
        ORDER BY prepared_at DESC NULLS LAST, created_at DESC
        LIMIT 5
      `);
      for (const row of rows) {
        if (!isYoutubeWatchUrl(row.url)) continue;
        return {
          broadcastId: row.broadcast_id,
          url: row.url,
          title: row.title,
          scheduledStartAt: new Date(row.scheduled_start_at),
          scheduledEndAt: new Date(row.scheduled_end_at),
        };
      }
      return null;
    } catch (error) {
      // youtuber側の先行デプロイ前やLAN DB障害でも、通常の定期投稿は継続する。
      console.error('[WARN][YOUTUBE_LIVE] Failed to get today broadcast:', error);
      return null;
    }
  }

  static async updateBiorhythmState(state: any) {
    const currentState = await this.getBiorhythmState();
    const newState = { ...currentState, ...state };
    await this.setBotState('biorhythm', newState);
  }

  static async updateTopPost(top: TopPost | null) {
    await this.setBotState('dailyTopPost', top);
  }

  static async getTopPost(): Promise<TopPost | null> {
    const stored = await this.getBotState('dailyTopPost');
    if (!stored?.uri) return null;
    return {
      ...stored,
      // network を持たない時代に書かれた行が残っているため、既定は Bluesky。
      network: stored.network === 'nagi' ? 'nagi' : 'bsky',
      comment: stored.comment ?? '',
      score: stored.score ?? 0,
    } as TopPost;
  }

  static async clearReplies() {
    try {
      await db.delete(replies);
    } catch (error) {
      console.error("Failed to clear replies:", error);
    }
  }

  static async clearPosts() {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      await db.delete(posts).where(lt(posts.created_at, sevenDaysAgo));
      console.log("[INFO] Pruned posts older than 7 days.");
    } catch (error) {
      console.error("Failed to prune old posts:", error);
    }
  }

  static async setWhimsicalPostRoot(uri: string) {
    try {
      await this.setBotState('whimsical_post_root', uri);
    } catch (error) {
      console.error("Failed to set whimsical post root:", error);
    }
  }

  static async setWhimsicalPostRoots(uris: string[]) {
    try {
      await this.setBotState('whimsical_post_roots', uris);
    } catch (error) {
      console.error("Failed to set whimsical post roots:", error);
    }
  }

  static async setQuestionState(uri: string, theme: string) {
    try {
      await Promise.all([
        this.setBotState('question_post_uri', uri),
        this.setBotState('question_theme', theme)
      ]);
    } catch (error) {
      console.error("Failed to set question state:", error);
    }
  }

  /**
   * bot日付内のおすすめ候補をBluesky / Nagiそれぞれスコア順で返す。
   *
   * 日付検証・公開Blueskyレコードの解決・ネットワーク横断の最終選出は
   * DailyTopPostProviderだけが担当する。
   */
  static async getDailyTopPostCandidateRows(
    start: Date,
    end: Date,
    limitPerNetwork = 5,
  ): Promise<DailyTopPostCandidateRow[]> {
    const botReply = alias(nagiPosts, 'bot_reply');
    const [bskyRows, nagiRows] = await Promise.all([
      db
        .select({
          uri: posts.uri,
          text: posts.post,
          comment: posts.comment,
          score: posts.score,
          createdAt: posts.created_at,
          did: posts.did,
        })
        .from(posts)
        .where(and(gte(posts.created_at, start), lt(posts.created_at, end)))
        .orderBy(desc(posts.score))
        .limit(limitPerNetwork),
      db
        .select({
          uri: nagiPosts.uri,
          cid: nagiPosts.cid,
          text: nagiPosts.text,
          comment: botReply.text,
          score: nagiPostScores.score,
          createdAt: nagiPosts.recordCreatedAt,
          did: nagiPosts.did,
          rkey: nagiPosts.rkey,
          handle: nagiActors.handle,
          displayName: nagiProfiles.displayName,
          avatarCid: nagiProfiles.avatarCid,
        })
        .from(nagiPostScores)
        .innerJoin(nagiPosts, eq(nagiPostScores.postUri, nagiPosts.uri))
        .leftJoin(botReply, eq(nagiPostScores.botReplyUri, botReply.uri))
        .leftJoin(nagiActors, eq(nagiPosts.did, nagiActors.did))
        .leftJoin(nagiProfiles, eq(nagiPosts.did, nagiProfiles.did))
        .where(
          and(
            isNull(nagiPosts.deletedAt),
            eq(nagiPosts.kossori, false),
            eq(nagiPosts.channelOnly, false),
            gte(nagiPosts.recordCreatedAt, start),
            lt(nagiPosts.recordCreatedAt, end),
          ),
        )
        .orderBy(desc(nagiPostScores.score))
        .limit(limitPerNetwork),
    ]);

    return [
      ...bskyRows.flatMap((row) =>
        row.uri && row.text
          ? [
              {
                network: 'bsky' as const,
                uri: row.uri,
                text: row.text,
                comment: row.comment ?? '',
                score: row.score ?? 0,
                createdAt: row.createdAt,
                did: row.did,
              },
            ]
          : [],
      ),
      ...nagiRows.map((row) => ({
        network: 'nagi' as const,
        uri: row.uri,
        cid: row.cid,
        text: row.text,
        comment: row.comment ?? '',
        score: row.score,
        createdAt: row.createdAt,
        did: row.did,
        handle: row.handle ?? undefined,
        displayName: row.displayName ?? undefined,
        avatarCid: row.avatarCid ?? undefined,
        rkey: row.rkey,
      })),
    ];
  }

  /**
   * 指定ユーザーが since 以降に Nagi へ投稿したポスト（日記の材料）。
   * こっそり投稿も材料に含める（本人の1日を書くものなので外さない）。そのぶん、
   * 1つでも混ざった日の日記は本人だけのものになる — 呼び出し元は kossori を見て判断する。
   */
  static async getNagiPostsSince(did: string, since: Date) {
    return db
      .select({
        uri: nagiPosts.uri,
        text: nagiPosts.text,
        langs: nagiPosts.langs,
        kossori: nagiPosts.kossori,
        recordCreatedAt: nagiPosts.recordCreatedAt,
      })
      .from(nagiPosts)
      .where(
        and(
          eq(nagiPosts.did, did),
          isNull(nagiPosts.deletedAt),
          gte(nagiPosts.recordCreatedAt, since),
        ),
      )
      .orderBy(nagiPosts.recordCreatedAt);
  }

  /**
   * since 以降に Nagi へ投稿したか。
   * Bluesky 側の日記を止めるかの判定に使うので、存在確認だけの軽いクエリにしている。
   */
  static async hasNagiPostsSince(did: string, since: Date): Promise<boolean> {
    const rows = await db
      .select({ uri: nagiPosts.uri })
      .from(nagiPosts)
      .where(
        and(
          eq(nagiPosts.did, did),
          isNull(nagiPosts.deletedAt),
          gte(nagiPosts.recordCreatedAt, since),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** since 以降に Nagi へ投稿したユーザーの DID 一覧（日記のスケジュール対象）。 */
  static async getNagiActiveAuthorsSince(since: Date): Promise<string[]> {
    const rows = await db
      .selectDistinct({ did: nagiPosts.did })
      .from(nagiPosts)
      .where(
        and(isNull(nagiPosts.deletedAt), gte(nagiPosts.recordCreatedAt, since)),
      );
    return rows.map((row) => row.did);
  }

static async getPost(did: string): Promise<any> {
    const result = await db.select().from(posts).where(eq(posts.did, did)).limit(1);
    return result[0] || {};
  }

  static async upsertPost(data: any) {
    await db.insert(posts)
      .values(data)
      .onConflictDoUpdate({
        target: posts.did,
        set: data
      });

    if (data.post) {
      generateEmbedding(data.post).then(async (embedding) => {
        if (embedding) {
          await db.update(posts).set({ embedding }).where(eq(posts.did, data.did));
        }
      }).catch((e) => console.error("[ERROR][upsertPost] embedding failed:", e));
    }
  }

  static async findFollowersByTopic(
    text: string,
    excludeDid?: string,
    threshold: number = 0.8
  ): Promise<Array<{ uri: string | null; did: string; post: string | null; score: number | null }>> {
    const embedding = await generateEmbedding(text);
    if (!embedding) return [];

    try {
      const vectorLiteral = `[${embedding.join(",")}]`;
      const maxDistance = 1 - threshold;
      const conditions = [
        sql`"embedding" IS NOT NULL`,
        sql`"embedding" <=> ${sql.raw(`'${vectorLiteral}'::vector`)} <= ${maxDistance}`,
        ...(excludeDid ? [sql`did != ${excludeDid}`] : []),
      ];
      return await db.select({ uri: posts.uri, did: posts.did, post: posts.post, score: posts.score })
        .from(posts)
        .where(sql.join(conditions, sql` AND `))
        .orderBy(sql`"embedding" <=> ${sql.raw(`'${vectorLiteral}'::vector`)}`)
        .limit(10);
    } catch (e) {
      console.error("[ERROR][findFollowersByTopic]", e);
      return [];
    }
  }

  static async getLike(did: string): Promise<any> {
    const result = await db.select().from(likes).where(eq(likes.did, did)).limit(1);
    return result[0] || {};
  }

  static async upsertLike(data: any) {
    await db.insert(likes)
      .values(data)
      .onConflictDoUpdate({
        target: likes.did,
        set: data
      });
    // Log interaction
    await this.logUsage('like', data.did);
  }

  static async deleteLike(did: string) {
    await db.delete(likes).where(eq(likes.did, did));
  }

  static async getReply(did: string): Promise<any> {
    const result = await db.select().from(replies).where(eq(replies.did, did)).limit(1);
    return result[0] || {};
  }

  static async addReply(data: any) {
    await db.insert(replies)
      .values(data)
      .onConflictDoUpdate({
        target: replies.did,
        set: data
      });
  }

  static async upsertReply(did: string, data: any) {
    const rowData = { ...data, did, updated_at: new Date() };
    await db.insert(replies)
      .values(rowData)
      .onConflictDoUpdate({
        target: replies.did,
        set: rowData
      });
  }

  static async addAffirmation(data: any) {
    await db.insert(affirmations).values(data);
    await this.logUsage('affirmation', data.did);
  }

  static async getFollower(did: string): Promise<any> {
    const result = await db.select().from(followers).where(eq(followers.did, did)).limit(1);
    return result[0] || {};
  }

  static async getFollowersByColumn(column: string, value: any): Promise<any[]> {
    return await db.select().from(followers).where(sql`${sql.identifier(column)} = ${value}`);
  }

  static async getPendingBadgeFollowers(): Promise<any[]> {
    return await db.select().from(followers).where(eq(followers.room_badge_pending, 1));
  }

  static async getPendingInteractionFollowers(): Promise<{ did: string; room_interaction_count: number | null }[]> {
    return await db
      .select({ did: followers.did, room_interaction_count: followers.room_interaction_count })
      .from(followers)
      .where(gt(followers.room_interaction_count, 0));
  }

  static async updateFollower(did: string, column: string, value: any) {
    await db.update(followers)
      .set({ [column]: value, updated_at: new Date() })
      .where(eq(followers.did, did));
  }

  static async ensureFollower(did: string) {
    const existing = await this.getFollower(did);
    await db.insert(followers)
      .values({ did })
      .onConflictDoNothing();

    // Log interaction if it's a new follower
    if (!existing.did) {
      await this.logUsage('follow', did);
      await this.logUsage('followers', did); // Increment followers count separately
    }
  }

  static async upsertFollowerInteraction(did: string) {
    await db.insert(followers)
      .values({ did, updated_at: new Date() })
      .onConflictDoUpdate({
        target: followers.did,
        set: { updated_at: new Date() }
      });
  }

  static async getUnreadReplies(): Promise<string[]> {
    const result = await db.select({ reply: replies.reply })
      .from(replies)
      .where(eq(replies.isRead, 0))
      .orderBy(sql`RANDOM()`);
    return result.map(r => r.reply).filter((r): r is string => !!r);
  }

  static async markRepliesRead() {
    await db.update(replies)
      .set({ isRead: 1 })
      .where(eq(replies.isRead, 0));
  }

  static async logUsage(type: string, did: string | null, details?: any) {
    try {
      await db.insert(interaction).values({
        type,
        did,
        details: details || null
      });

      await this.incrementStats(type);

    } catch (e) {
      console.error(`Failed to log interaction for ${type}:`, e);
    }
  }

  private static async getStatsWithMap(key: string): Promise<Stats> {
    const stats = (await this.getBotState(key)) as Stats || this.getEmptyStats();
    if (!(stats.lang instanceof Map)) {
      stats.lang = new Map<LanguageName, number>(Object.entries(stats.lang || {}) as [LanguageName, number][]);
    }
    return stats;
  }

  private static async saveStatsWithMap(key: string, stats: Stats) {
    // Convert Map to Object for storage if needed, but we modify the stats object in place usually
    // Let's ensure we don't mutate the Map in a way that breaks JSON if we just rely on default serialization?
    // Drizzle jsonb handles objects. Maps serialize to {} by default in JSON.stringify.
    // So we MUST convert Map to Object before saving.
    const statsToSave = { ...stats };
    if (stats.lang instanceof Map) {
      statsToSave.lang = Object.fromEntries(stats.lang) as any;
    }
    await this.setBotState(key, statsToSave);
  }

  static async incrementStats(type: string, amount: number = 1) {
    try {
      const currentStats = await this.getStatsWithMap('totalStats');

      // Update specific stat
      if (type === 'followers') currentStats.followers += amount;
      else if (type === 'like') currentStats.likes += amount;
      else if (type === 'reply') currentStats.reply += amount;
      else if (type === 'affirmation') currentStats.affirmationCount += amount;
      else if (type === 'conversation') currentStats.conversation += amount;
      else if (type === 'fortune') currentStats.fortune += amount;
      else if (type === 'cheer') currentStats.cheer += amount;
      else if (type === 'analysis') currentStats.analysis += amount;
      else if (type === 'dj') currentStats.dj += amount;
      else if (type === 'anniversary') currentStats.anniversary += amount;
      else if (type === 'answer') currentStats.answer += amount;
      else if (type === 'recap') currentStats.recap += amount;
      else if (type === 'rpd') currentStats.rpd += amount;
      else if (type === 'rpdError') currentStats.rpdError += amount;
      else if (type === 'bskyrate') currentStats.bskyrate += amount;

      await this.saveStatsWithMap('totalStats', currentStats);
    } catch (e) {
      console.error(`Failed to increment stats for ${type}:`, e);
    }
  }

  static async incrementLang(langName: LanguageName) {
    try {
      const currentStats = await this.getStatsWithMap('totalStats');

      const count = currentStats.lang.get(langName) || 0;
      currentStats.lang.set(langName, count + 1);

      await this.saveStatsWithMap('totalStats', currentStats);
    } catch (e) {
      console.error(`Failed to increment lang for ${langName}:`, e);
    }
  }

  static getEmptyStats(): Stats {
    return {
      followers: 0,
      likes: 0,
      reply: 0,
      affirmationCount: 0,
      conversation: 0,
      fortune: 0,
      cheer: 0,
      analysis: 0,
      dj: 0,
      anniversary: 0,
      answer: 0,
      recap: 0,
      lang: new Map(),
      bskyrate: 0,
      rpd: 0,
      rpdError: 0
    };
  }

  static async resetDailyStats() {
    try {
      const totalStats = await this.getStatsWithMap('totalStats');
      await this.saveStatsWithMap('yesterdayStats', totalStats);
      await this.setBotState('stats_last_reset_at', new Date().toISOString());
    } catch (e) {
      console.error("Failed to reset daily stats:", e);
    }
  }

  static async getDailyStats(): Promise<DailyReport> {
    const totalStats = await this.getStatsWithMap('totalStats');
    const yesterdayStats = await this.getStatsWithMap('yesterdayStats');
    const dailyTopPostData = await this.getBotState('dailyTopPost');
    const lastResetAt = await this.getBotState('stats_last_reset_at');

    const lastResetDate = lastResetAt ? new Date(lastResetAt) : new Date();

    const diff = (key: keyof Stats) => {
      const total = (totalStats[key] as number) || 0;
      const yesterday = (yesterdayStats[key] as number) || 0;
      return total - yesterday;
    };

    const getLangDiff = () => {
      const tMap = totalStats.lang;
      const yMap = yesterdayStats.lang;
      const diffMap = new Map<LanguageName, number>();

      tMap.forEach((v: number, k: LanguageName) => {
        const yVal = yMap.get(k) || 0;
        diffMap.set(k, v - yVal);
      });
      return diffMap;
    };

    // Calculate unique affirmations since last reset
    let uniqueAffirmationCount = 0;
    try {
      const result = await db.select({ count: sql`count(distinct ${affirmations.did})` })
        .from(affirmations)
        .where(gte(affirmations.created_at, lastResetDate));
      uniqueAffirmationCount = Number(result[0]?.count || 0);
    } catch (e) {
      console.error("Failed to get unique affirmation count:", e);
    }

    return {
      followers: diff('followers'),
      likes: diff('likes'),
      reply: diff('reply'),
      affirmationCount: diff('affirmationCount'),
      uniqueAffirmationUserCount: uniqueAffirmationCount,
      conversation: diff('conversation'),
      fortune: diff('fortune'),
      cheer: diff('cheer'),
      analysis: diff('analysis'),
      dj: diff('dj'),
      anniversary: diff('anniversary'),
      answer: diff('answer'),
      recap: diff('recap'),
      lang: getLangDiff(),
      topPost: dailyTopPostData?.uri || "",
      botComment: dailyTopPostData?.comment || "",
      // 既定が 'bsky' なのは、network を持たない時代に書かれた行が残っているため。
      topPostNetwork: dailyTopPostData?.network === 'nagi' ? 'nagi' : 'bsky',
      bskyrate: diff('bskyrate'),
      rpd: diff('rpd'),
      rpdError: diff('rpdError'),
      lastInitializedDate: lastResetAt || new Date().toISOString()
    } as DailyReport;
  }

  static async getTotalStats(): Promise<any> {
    const stats = await this.getStatsWithMap('totalStats');
    return {
      ...stats,
      lang: Object.fromEntries(stats.lang)
    };
  }

  static async checkRPD(): Promise<boolean> {
    try {
      const dailyStats = await this.getDailyStats();
      const rpdCount = dailyStats.rpd || 0;
      const repliesCount = dailyStats.reply || 0;

      // Gemini RPD limit check
      if (rpdCount >= LIMIT_REQUEST_PER_DAY_GEMINI) {
        console.warn(`[WARN] Gemini RPD limit reached (${rpdCount}/${LIMIT_REQUEST_PER_DAY_GEMINI})`);
        return false;
      }

      // Safety limit for replies (300)
      // if (repliesCount >= 300) {
      //   console.warn(`[WARN] Reply limit reached (${repliesCount}/300)`);
      //   return false;
      // }

      return true;
    } catch (e) {
      console.error("Error in checkRPD:", e);
      return true; // Default to true on error
    }
  }

  static async getSubscribersOrDeveloper(): Promise<string[]> {
    try {
      const result = await db.select({ did: subscribers.did })
        .from(subscribers)
        .where(eq(subscribers.status, 'active'));
      const list = result.map(row => row.did);

      const devDid = process.env.DEVELOPER_DID;
      if (devDid) {
        const devDids = devDid.split(',').map(d => d.trim()).filter(Boolean);
        for (const did of devDids) {
          if (!list.includes(did)) {
            list.push(did);
          }
        }
      }
      return list;
    } catch (e) {
      console.error("Failed to get subscribers or developer from database:", e);
      return [];
    }
  }

  static async getCommunityMembersOrDeveloper(): Promise<string[]> {
    try {
      const result = await db.select({ did: subscribers.did })
        .from(subscribers)
        .where(inArray(subscribers.status, ['active', 'discord_only']));
      const list = result.map(row => row.did);

      const devDid = process.env.DEVELOPER_DID;
      if (devDid) {
        const devDids = devDid.split(',').map(d => d.trim()).filter(Boolean);
        for (const did of devDids) {
          if (!list.includes(did)) {
            list.push(did);
          }
        }
      }
      return list;
    } catch (e) {
      console.error("Failed to get community members or developer from database:", e);
      return [];
    }
  }

  static async getSubscriberDidsIncludingInactive(): Promise<string[]> {
    try {
      const result = await db.select({ did: subscribers.did })
        .from(subscribers);
      return result.map(row => row.did);
    } catch (e) {
      console.error("Failed to get subscriber DIDs including inactive:", e);
      return [];
    }
  }

  static async addSubscriber(did: string, discordId?: string) {
    try {
      const data = {
        did,
        discord_id: discordId || null,
        status: 'active',
        updated_at: new Date()
      };
      await db.insert(subscribers)
        .values(data)
        .onConflictDoUpdate({
          target: subscribers.did,
          set: data
        });
      console.log(`[INFO] Subscriber added/updated in DB: ${did} (Discord: ${discordId || 'N/A'})`);
    } catch (e) {
      console.error(`Failed to add subscriber for ${did}:`, e);
      throw e;
    }
  }

  static async removeSubscriberByDid(did: string) {
    try {
      await db.update(subscribers)
        .set({ status: 'inactive', updated_at: new Date() })
        .where(eq(subscribers.did, did));
      console.log(`[INFO] Subscriber deactivated in DB by DID: ${did}`);
    } catch (e) {
      console.error(`Failed to deactivate subscriber by DID ${did}:`, e);
      throw e;
    }
  }

  static async removeSubscriberByDiscordId(discordId: string) {
    try {
      await db.update(subscribers)
        .set({ status: 'inactive', updated_at: new Date() })
        .where(eq(subscribers.discord_id, discordId));
      console.log(`[INFO] Subscriber deactivated in DB by Discord ID: ${discordId}`);
    } catch (e) {
      console.error(`Failed to deactivate subscriber by Discord ID ${discordId}:`, e);
      throw e;
    }
  }

  static async getDiscordLinkedSubscriberIds(): Promise<string[]> {
    try {
      const result = await db.select({ discord_id: subscribers.discord_id })
        .from(subscribers)
        .where(
          and(
            inArray(subscribers.status, ['active', 'discord_only']),
            sql`${subscribers.discord_id} IS NOT NULL`
          )
        );
      return result.map(row => row.discord_id as string);
    } catch (e) {
      console.error("Failed to get Discord-linked subscriber IDs:", e);
      return [];
    }
  }

  static async updateSubscriberStatus(did: string, status: 'active' | 'inactive' | 'discord_only') {
    try {
      await db.update(subscribers)
        .set({ status, updated_at: new Date() })
        .where(eq(subscribers.did, did));
      console.log(`[INFO] Subscriber status updated to ${status} for DID: ${did}`);
    } catch (e) {
      console.error(`Failed to update subscriber status for ${did}:`, e);
      throw e;
    }
  }

  static async addBiorhythmHistory(status: string, mood: string, mood_en: string, energy: number) {
    try {
      const [row] = await db
        .insert(biorhythm_history)
        .values({ status, mood, mood_en, energy })
        .returning({ id: biorhythm_history.id, createdAt: biorhythm_history.created_at });
      if (row) {
        await tryUpsertBotMemoryDocument({
          sourceType: 'biorhythm',
          sourceId: String(row.id),
          content: mood,
          occurredAt: row.createdAt,
          metadata: { status, moodEn: mood_en, energy },
        });
      }
    } catch (e) {
      console.error("Failed to add biorhythm history:", e);
    }
  }

  static async getBiorhythmHistorySince(since: Date): Promise<any[]> {
    try {
      return await db.select()
        .from(biorhythm_history)
        .where(gte(biorhythm_history.created_at, since))
        .orderBy(biorhythm_history.created_at);
    } catch (e) {
      console.error("Failed to get biorhythm history since:", since, e);
      return [];
    }
  }

  static async getInteractionsSince(since: Date): Promise<any[]> {
    try {
      return await db.select()
        .from(interaction)
        .where(gte(interaction.created_at, since))
        .orderBy(interaction.created_at);
    } catch (e) {
      console.error("Failed to get interactions since:", since, e);
      return [];
    }
  }

  static async getTodayNewGifts(): Promise<any[]> {
    try {
      const todayStart = new Date();
      if (todayStart.getHours() < 4) {
        todayStart.setDate(todayStart.getDate() - 1);
      }
      todayStart.setHours(4, 0, 0, 0);
      return await db.select()
        .from(gifts)
        .where(and(eq(gifts.status, 'new'), gte(gifts.created_at, todayStart)))
        .orderBy(gifts.created_at);
    } catch (e) {
      console.error("Failed to get today's new gifts:", e);
      return [];
    }
  }

  static async getRandomOldGift(): Promise<any | null> {
    try {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const result = await db.select()
        .from(gifts)
        .where(lte(gifts.updated_at, threeDaysAgo))
        .orderBy(sql`RANDOM()`)
        .limit(1);
      return result[0] ?? null;
    } catch (e) {
      console.error("Failed to get random old gift:", e);
      return null;
    }
  }

  static async updateGiftStatus(id: number, status: "introduced" | "used"): Promise<void> {
    try {
      await db.update(gifts)
        .set({ status, updated_at: new Date() })
        .where(eq(gifts.id, id));
    } catch (e) {
      console.error(`Failed to update gift status for id ${id}:`, e);
    }
  }

  /**
   * お部屋の未読イベント。biorhythm の行動生成に使う。
   *
   * 長期停止したあとに再開すると数百件たまっている可能性があり、そのまま全部
   * プロンプトに載せると1回の生成が壊れる。古いものから limit 件だけ見る。
   */
  static async getUnreadRoomEvents(limit = 20): Promise<RoomEvent[]> {
    try {
      return await db.select({
        id: room_events.id,
        did: room_events.did,
        type: room_events.type,
        detail: room_events.detail,
        created_at: room_events.created_at,
      })
        .from(room_events)
        .where(eq(room_events.is_read, 0))
        .orderBy(room_events.created_at)
        .limit(limit);
    } catch (e) {
      console.error("Failed to get unread room events:", e);
      return [];
    }
  }

  /**
   * 取得した行だけを既読にする。
   *
   * replies の markRepliesRead() のように「未読すべて」を潰すと、取得〜生成の間に
   * 入ったイベントを一度も読まずに捨てることになる。お部屋の体験が消えるので id 指定。
   */
  static async markRoomEventsRead(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await db.update(room_events)
        .set({ is_read: 1 })
        .where(inArray(room_events.id, ids));
    } catch (e) {
      console.error("Failed to mark room events read:", e);
    }
  }

  static async getNewYoutubeShort(): Promise<{ id: number; url: string; title: string | null } | null> {
    try {
      const result = await db.select()
        .from(youtube_shorts)
        .where(eq(youtube_shorts.status, 'new'))
        .orderBy(desc(youtube_shorts.created_at))
        .limit(1);
      return result[0] ?? null;
    } catch (e) {
      console.error("Failed to get new YouTube Short:", e);
      return null;
    }
  }

  static async updateYoutubeShortStatus(id: number, status: "posted"): Promise<void> {
    try {
      await db.update(youtube_shorts)
        .set({ status, updated_at: new Date() })
        .where(eq(youtube_shorts.id, id));
    } catch (e) {
      console.error(`Failed to update YouTube Short status for id ${id}:`, e);
    }
  }

  // ------------------------------------------------------------------
  // bot-tan.com ダッシュボード用の集計
  // ------------------------------------------------------------------

  /**
   * Nagi SNS 全体の規模と活動。bot アカウントへの反応に限定せず、
   * AppView が取り込んだ nagi スキーマの全レコードを対象にする。
   * 前日はダッシュボードの日次集計と同じ JST 暦日で区切る。
   */
  static async getNagiStats(): Promise<NagiStats> {
    const num = (value: unknown): number => Number(value ?? 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const todayStartMs = Math.floor((Date.now() + jstOffsetMs) / dayMs) * dayMs - jstOffsetMs;
    const yesterdayStart = new Date(todayStartMs - dayMs);
    const todayStart = new Date(todayStartMs);

    const queries = [
      // 検索に出るユーザーの定義（nagi_appview の searchActors）に合わせる。
      db
        .select({
          total: sql`count(*)`,
          addedYesterday: sql`count(*) filter (where ${and(
            gte(nagiProfiles.createdAt, yesterdayStart),
            lt(nagiProfiles.createdAt, todayStart),
          )})`,
        })
        .from(nagiProfiles)
        .innerJoin(nagiActors, eq(nagiActors.did, nagiProfiles.did))
        .where(eq(nagiActors.status, 'active')),

      db.select({ total: sql`count(*)` }).from(nagiReactions),

      db
        .select({ total: sql`count(*)` })
        .from(nagiPosts)
        .where(isNull(nagiPosts.deletedAt)),

      db
        .select({ total: sql`count(*)` })
        .from(nagiChannels)
        .where(isNull(nagiChannels.deletedAt)),
    ] as const;

    const settled = await Promise.allSettled(queries);
    const names = ['users', 'reactions', 'posts', 'channels'] as const;
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Failed to get Nagi ${names[index]} stats:`, result.reason);
      }
    });
    const value = <T>(index: number, fallback: T): T =>
      settled[index]?.status === 'fulfilled' ? (settled[index].value as T) : fallback;
    const users = value(0, [{ total: 0, addedYesterday: 0 }]);
    const reactions = value(1, [{ total: 0 }]);
    const posts = value(2, [{ total: 0 }]);
    const channels = value(3, [{ total: 0 }]);

    return {
      totalUsers: num(users[0]?.total),
      usersAddedYesterday: num(users[0]?.addedYesterday),
      totalReactions: num(reactions[0]?.total),
      totalPosts: num(posts[0]?.total),
      totalChannels: num(channels[0]?.total),
    };
  }

  /** PDSが受理したbotアカウントのrepo書き込みを追記する。 */
  static async recordRepoWrite(
    did: string,
    action: RepoWriteAction,
    source: string,
  ): Promise<void> {
    await db.insert(repo_write_points).values({
      did,
      action,
      points: REPO_WRITE_POINTS[action],
      source,
    });
  }

  /** 公式上限と同じローリング1時間・24時間の使用量。 */
  static async getRepoWritePointUsage(
    did: string | undefined,
  ): Promise<RepoWritePointUsage> {
    const empty: RepoWritePointUsage = {
      hour: { used: 0, limit: 5000, windowSeconds: 3600 },
      day: { used: 0, limit: 35000, windowSeconds: 86400 },
    };
    if (!did) return empty;

    const now = Date.now();
    const hourSince = new Date(now - 3_600_000);
    const daySince = new Date(now - 86_400_000);
    try {
      const rows = await db
        .select({
          hour: sql`coalesce(sum(${repo_write_points.points}) filter (where ${gte(repo_write_points.created_at, hourSince)}), 0)`,
          day: sql`coalesce(sum(${repo_write_points.points}) filter (where ${gte(repo_write_points.created_at, daySince)}), 0)`,
        })
        .from(repo_write_points)
        .where(eq(repo_write_points.did, did));
      return {
        hour: { ...empty.hour, used: Number(rows[0]?.hour ?? 0) },
        day: { ...empty.day, used: Number(rows[0]?.day ?? 0) },
      };
    } catch (error) {
      console.error('Failed to get repo write point usage:', error);
      return empty;
    }
  }

  /**
   * Nagi ユーザー数の推移。profiles.created_at が残っているので、
   * daily_metrics を入れる前の期間もさかのぼって描ける。
   */
  static async getNagiUserHistory(days: number): Promise<{ date: string; count: number }[]> {
    try {
      const rows = await db.execute<{ date: string; count: string }>(sql`
        with daily as (
          select (${nagiProfiles.createdAt} at time zone 'Asia/Tokyo')::date as day,
                 count(*) as added
          from ${nagiProfiles}
          group by 1
        )
        select to_char(day, 'YYYY-MM-DD') as date,
               sum(added) over (order by day) as count
        from daily
        order by day
      `);
      // 累積なので、切り出しは合計を出したあとで行う。
      return rows.slice(-days).map((row) => ({ date: row.date, count: Number(row.count) }));
    } catch (e) {
      console.error('Failed to get Nagi user history:', e);
      return [];
    }
  }

  /**
   * Nagi チャンネル数の推移。nagiChannels.record_created_at から
   * daily_metrics を入れる前の期間もさかのぼって描ける。
   */
  static async getNagiChannelHistory(days: number): Promise<{ date: string; count: number }[]> {
    try {
      const rows = await db.execute<{ date: string; count: string }>(sql`
        with daily as (
          select (${nagiChannels.recordCreatedAt} at time zone 'Asia/Tokyo')::date as day,
                 count(*) as added
          from ${nagiChannels}
          where ${isNull(nagiChannels.deletedAt)}
          group by 1
        )
        select to_char(day, 'YYYY-MM-DD') as date,
               sum(added) over (order by day) as count
        from daily
        order by day
      `);
      return rows.slice(-days).map((row) => ({ date: row.date, count: Number(row.count) }));
    } catch (e) {
      console.error('Failed to get Nagi channel history:', e);
      return [];
    }
  }

  /**
   * Nagi リアクション数とポスト数の 1h おきのアクティビティ（デフォルト直近 168 時間＝7 日間）。
   */
  static async getNagiHourlyActivity(
    hours = 168,
  ): Promise<{ hour: string; reactions: number; posts: number }[]> {
    try {
      const rows = await db.execute<{ hour: string; reactions: string; posts: string }>(sql`
        with hourly as (
          select generate_series(
            date_trunc('hour', now() at time zone 'Asia/Tokyo') - (${sql.raw(`${hours - 1}`)} || ' hours')::interval,
            date_trunc('hour', now() at time zone 'Asia/Tokyo'),
            interval '1 hour'
          ) as hour_jst
        ),
        r as (
          select date_trunc('hour', ${nagiReactions.indexedAt} at time zone 'Asia/Tokyo') as hour_jst,
                 count(*) as count
          from ${nagiReactions}
          where ${gte(nagiReactions.indexedAt, sql`now() - (${sql.raw(`${hours}`)} || ' hours')::interval`)}
          group by 1
        ),
        p as (
          select date_trunc('hour', ${nagiPosts.recordCreatedAt} at time zone 'Asia/Tokyo') as hour_jst,
                 count(*) as count
          from ${nagiPosts}
          where ${isNull(nagiPosts.deletedAt)}
            and ${gte(nagiPosts.recordCreatedAt, sql`now() - (${sql.raw(`${hours}`)} || ' hours')::interval`)}
          group by 1
        )
        select to_char(h.hour_jst, 'YYYY-MM-DD HH24:00') as hour,
               coalesce(r.count, 0) as reactions,
               coalesce(p.count, 0) as posts
        from hourly h
        left join r on r.hour_jst = h.hour_jst
        left join p on p.hour_jst = h.hour_jst
        order by h.hour_jst
      `);
      return rows.map((row) => ({
        hour: row.hour,
        reactions: Number(row.reactions),
        posts: Number(row.posts),
      }));
    } catch (e) {
      console.error('Failed to get Nagi hourly activity:', e);
      return [];
    }
  }

  /** その日の確定値を1行だけ残す。日次リセットの直前に呼ぶ。 */
  static async saveDailyMetrics(date: string, metrics: Record<string, unknown>): Promise<void> {
    try {
      await db
        .insert(daily_metrics)
        .values({ date, metrics })
        .onConflictDoUpdate({ target: daily_metrics.date, set: { metrics } });
    } catch (e) {
      console.error(`Failed to save daily metrics for ${date}:`, e);
    }
  }

  static async getDailyMetrics(days: number): Promise<{ date: string; metrics: any }[]> {
    try {
      const rows = await db
        .select({ date: daily_metrics.date, metrics: daily_metrics.metrics })
        .from(daily_metrics)
        .orderBy(desc(daily_metrics.date))
        .limit(days);
      return rows.reverse();
    } catch (e) {
      console.error('Failed to get daily metrics:', e);
      return [];
    }
  }

  /**
   * 活動タイムライン用。`since` 以降の履歴に加えて、`since` 時点で継続していた
   * 1件を先読みして返す。これがないと、その日の最初のログより前の時間帯が
   * 毎朝ぽっかり空く。
   */
  static async getBiorhythmHistoryForTimeline(since: Date, until: Date): Promise<any[]> {
    try {
      const [carryOver, within] = await Promise.all([
        db
          .select()
          .from(biorhythm_history)
          .where(lt(biorhythm_history.created_at, since))
          .orderBy(desc(biorhythm_history.created_at))
          .limit(1),
        db
          .select()
          .from(biorhythm_history)
          .where(and(gte(biorhythm_history.created_at, since), lt(biorhythm_history.created_at, until)))
          .orderBy(biorhythm_history.created_at),
      ]);
      return [...carryOver, ...within];
    } catch (e) {
      console.error('Failed to get biorhythm history for timeline:', e);
      return [];
    }
  }

  /**
   * タイムラインに打つイベントマーカー。
   * **did と本文は返さない** — このデータは公開エンドポイントから配信される。
   */
  static async getInteractionMarkers(
    since: Date,
    until: Date,
    types: string[],
  ): Promise<{ at: string; type: string }[]> {
    if (types.length === 0) return [];
    try {
      const rows = await db
        .select({ type: interaction.type, created_at: interaction.created_at })
        .from(interaction)
        .where(
          and(
            gte(interaction.created_at, since),
            lt(interaction.created_at, until),
            inArray(interaction.type, types),
          ),
        )
        .orderBy(interaction.created_at);
      return rows.map((row) => ({ at: row.created_at.toISOString(), type: row.type }));
    } catch (e) {
      console.error('Failed to get interaction markers:', e);
      return [];
    }
  }

  /**
   * botたんに呼んでほしい名前。無ければ null（呼び出し側は displayName に落とす）。
   *
   * DID キーなので Bluesky 側のリプライからも同じ行を引ける。読み取りは両ボットから
   * 行うが、**書き込むのは Nagi 側だけ**（Bluesky から呼び方を変える経路は作らない）。
   *
   * 失敗しても null を返す。呼び名が反映されないだけで、返信生成は止めない。
   */
  static async getPreferredName(did: string): Promise<string | null> {
    try {
      const rows = await db
        .select({ name: nagiPreferredNames.name })
        .from(nagiPreferredNames)
        .where(eq(nagiPreferredNames.did, did))
        .limit(1);
      return rows[0]?.name ?? null;
    } catch (e) {
      console.error('Failed to get preferred name:', e);
      return null;
    }
  }

  /**
   * 呼び名を登録・更新する。後勝ち（本人の最新の申告が常に正しい）。
   * source は由来: declared = 会話での申告、manual = 設定画面での入力。
   */
  static async setPreferredName(input: {
    did: string;
    name: string;
    source: 'declared' | 'manual';
    model?: string;
    promptVersion?: string;
  }): Promise<void> {
    try {
      await db
        .insert(nagiPreferredNames)
        .values({
          did: input.did,
          name: input.name,
          source: input.source,
          model: input.model ?? null,
          promptVersion: input.promptVersion ?? null,
        })
        .onConflictDoUpdate({
          target: nagiPreferredNames.did,
          set: {
            name: sql`excluded.name`,
            source: sql`excluded.source`,
            model: sql`excluded.model`,
            promptVersion: sql`excluded.prompt_version`,
            updatedAt: sql`now()`,
          },
        });
    } catch (e) {
      console.error('Failed to set preferred name:', e);
    }
  }

  /** 呼び名の登録を解除する。以降は displayName に戻る。 */
  static async clearPreferredName(did: string): Promise<void> {
    try {
      await db.delete(nagiPreferredNames).where(eq(nagiPreferredNames.did, did));
    } catch (e) {
      console.error('Failed to clear preferred name:', e);
    }
  }
}
