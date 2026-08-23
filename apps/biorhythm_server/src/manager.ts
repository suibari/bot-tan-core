import eventsMorningWorkday from "@bsky-affirmative-bot/shared-configs/json/event_morning_workday.json" with { type: "json" };
import eventsMorningDayoff from "@bsky-affirmative-bot/shared-configs/json/event_morning_dayoff.json" with { type: "json" };
import eventsNoonWorkday from "@bsky-affirmative-bot/shared-configs/json/event_noon_workday.json" with { type: "json" };
import eventsNoonDayoff from "@bsky-affirmative-bot/shared-configs/json/event_noon_dayoff.json" with { type: "json" };
import eventsEveningWorkday from "@bsky-affirmative-bot/shared-configs/json/event_evening_workday.json" with { type: "json" };
import eventsEveningDayoff from "@bsky-affirmative-bot/shared-configs/json/event_evening_dayoff.json" with { type: "json" };
import eventsNight from "@bsky-affirmative-bot/shared-configs/json/event_night.json" with { type: "json" };
import eventsMidnight from "@bsky-affirmative-bot/shared-configs/json/event_midnight.json" with { type: "json" };
import { BOT_SCENE_BRIEF_JA, botDayRange } from '@bsky-affirmative-bot/shared-configs';
import { gemini, generateContentWithRetry } from '@bsky-affirmative-bot/bot-brain';
import { DailyReport, Stats } from '@bsky-affirmative-bot/shared-configs';
import EventEmitter from "events";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import type {
  NagiStats,
  RecentBotMemoryImpression,
  RepoWritePointUsage,
  RoomEvent,
  TopPost,
} from "@bsky-affirmative-bot/database";
import { getRecentBotMemoryImpressions } from "@bsky-affirmative-bot/database";
import { getCachedHealthSnapshot, type HealthSnapshot } from "./healthMonitor.js";
import { getFullDateAndTimeString } from "@bsky-affirmative-bot/shared-configs";
import { LanguageName } from "@bsky-affirmative-bot/shared-configs";

import { UtilityAI } from "./utilityAI.js";
import { buildBiorhythmBotContext } from "./botMemory.js";
import {
  buildPlannedEventSection,
  ensureDailyPlan,
  markPlannedEventUsed,
  takePlannedEvent,
  type DailyPlan,
} from "./dailyPlan.js";
import { fetchDisplayName } from "./displayName.js";
import {
  buildRoomEventsSection,
  toRoomEventsForPrompt,
  type RoomEventForPrompt,
} from "./roomEventPrompt.js";
import { getYokohamaWeather } from "@bsky-affirmative-bot/bot-brain";
import { Type } from "@google/genai";

import { Status } from "@bsky-affirmative-bot/shared-configs";
import { postGoodNight, postMorning, postWhimsical } from "./ScheduledPostCoordinator.js";
import {
  DASHBOARD_TOP_POST_SOURCE,
  getDailyTopPostCandidate,
  toDashboardTopPost,
} from "./DailyTopPostProvider.js";
import {
  shouldConsiderWhimsicalPost,
  shouldPostGoodMorning,
} from "./scheduledPostGate.js";
import {
  DEFAULT_STEP_INTERVAL_MS,
  getNextStepTime,
  getStartupStepDelayMs,
  resolveStartupStepSchedule,
} from "./biorhythmSchedule.js";

// WebSocket用にlangプロパティを配列に変換したDailyStatsの型を定義
interface DailyStatsForWebSocket extends Omit<DailyReport, 'lang'> { // DailyStatsをDailyReportに変更
  lang: [LanguageName, number][];
}

interface BotStat {
  energy: number;
  mood: string;
  mood_en: string;
  status: string;
  dailyStats: DailyStatsForWebSocket; // 型をDailyStatsForWebSocketに変更
  totalStats: Stats; // 追加: totalStatsプロパティ
  utilities: Record<Status, number>;
  nextStepTime: string;
  /** bot-tan.com のダッシュボード用。既存フィールドは互換のため触らない。 */
  bsky: { currentFollowers: number };
  nagi: NagiStats;
  repoWritePoints: RepoWritePointUsage;
  health: HealthSnapshot | null;
  topPost: TopPost | null;
  memoryImpressions: RecentBotMemoryImpression[];
}

const ENERGY_MAXIMUM = 10000;
const NAGI_STATS_TTL_MS = 60_000;
const REPO_WRITE_POINTS_TTL_MS = 10_000;
const MEMORY_IMPRESSIONS_TTL_MS = 5 * 60_000;

export class BiorhythmManager extends EventEmitter {
  private status: Status = 'Sleep';
  private statusPrev: Status = 'Sleep';
  private energy: number = 5000;
  private energyPrev: number = 5000;
  private timePrev: string = '';
  private moodPrev: string = "";
  private moodPrevEn: string = "";
  private nextStepTime: string = "";
  private _generatedImage: Buffer | null = null;
  private currentFollowers = 0;
  /**
   * Nagi の集計は6本のクエリを束ねたもので、getCurrentState() は statsChange の
   * たびに呼ばれる。毎回叩かないよう短い TTL で持ち回す。
   */
  private nagiStatsCache: { at: number; value: NagiStats } | null = null;
  private repoWritePointsCache: { at: number; value: RepoWritePointUsage } | null =
    null;
  private memoryImpressionsCache: {
    at: number;
    value: RecentBotMemoryImpression[];
  } | null = null;
  private firstStepDone = false;
  private lastGoodNightPostDate?: string;
  private lastGoodMorningPostDate?: string;
  /** bottan_live.comments のうち energy へ反映済みの最大 id。null は初回未設定。 */
  private liveCommentEnergyCursor: number | null = null;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    // logger.on("statsChange", () => { ... }); 
    // We don't have local logger emitting events anymore. 
    // We should emit our own changes when we update state.
  }

  async init() {
    // await logger.loadLogFromFile();
    const state = await MemoryService.getBiorhythmState();
    if (state.energy !== undefined) {
      this.energy = state.energy;
    } else {
      this.energy = 5000;
    }
    if (state.mood !== undefined) {
      this.moodPrev = state.mood;
    }
    if (state.mood_en !== undefined) {
      this.moodPrevEn = state.mood_en;
    }
    if (state.status !== undefined) {
      this.status = state.status as Status;
    } else {
      this.status = "Sleep";
    }
    if (
      typeof state.nextStepTime === "string"
      && Number.isFinite(Date.parse(state.nextStepTime))
    ) {
      this.nextStepTime = state.nextStepTime;
    }
    this.lastGoodNightPostDate = state.lastGoodNightPostDate;
    this.lastGoodMorningPostDate = state.lastGoodMorningPostDate;
    if (Number.isSafeInteger(state.liveCommentEnergyCursor) && state.liveCommentEnergyCursor >= 0) {
      this.liveCommentEnergyCursor = state.liveCommentEnergyCursor;
    }

    const lastFollowers = await MemoryService.getBotState("last_follower_count");
    if (typeof lastFollowers === "number") this.currentFollowers = lastFollowers;

    await this.refreshDailyTopPost();
    await this.updateFollowerCount();
    setInterval(() => this.refreshDailyTopPost(), 10 * 60 * 1000);
    setInterval(() => this.updateFollowerCount(), 10 * 60 * 1000);
  }

  /**
   * 永続化済みの次回時刻からループを再開する。再デプロイが予定時刻より前なら、
   * mood は更新せず残り時間だけ待つ。旧データまたは期限超過時だけ即時実行する。
   */
  async start() {
    const schedule = resolveStartupStepSchedule(this.nextStepTime);
    this.nextStepTime = schedule.nextStepTime;
    if (schedule.needsPersistence) {
      await MemoryService.updateBiorhythmState({ nextStepTime: this.nextStepTime });
      console.log(`[INFO][BIORHYTHM] Initialized first scheduled step at ${this.nextStepTime}`);
    } else if (schedule.delayMs > 0) {
      console.log(`[INFO][BIORHYTHM] Resuming scheduled step at ${this.nextStepTime}`);
    } else {
      console.log(`[INFO][BIORHYTHM] Scheduled step is due; starting now (${this.nextStepTime})`);
    }
    this.armStepTimer(schedule.delayMs);
  }

  private armStepTimer(delayMs: number) {
    if (this.stepTimer) clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => {
      this.stepTimer = null;
      void this.step().catch((error) => {
        console.error("[ERROR][BIORHYTHM] Unexpected step failure:", error);
        void this.scheduleNextStep(DEFAULT_STEP_INTERVAL_MS).catch((scheduleError) => {
          console.error("[ERROR][BIORHYTHM] Failed to schedule step retry:", scheduleError);
        });
      });
    }, delayMs);
  }

  private async scheduleNextStep(intervalMs: number) {
    this.nextStepTime = getNextStepTime(intervalMs);
    await MemoryService.updateBiorhythmState({ nextStepTime: this.nextStepTime });
    this.armStepTimer(getStartupStepDelayMs(this.nextStepTime));
  }

  // --------
  // メソッド
  // --------
  async addLike() {
    await this.changeEnergy(10);
  }

  addAffirmation(did: string) {
    this.getCurrentState().then(state => this.emit('statsChange', state));
  }

  async addFortune() {
    await this.changeEnergy(100);
  }

  async addCheer() {
    await this.changeEnergy(100);
  }

  async addAnalysis() {
    await this.changeEnergy(100);
  }

  async addDJ() {
    await this.changeEnergy(50);
  }

  async addConversation() {
    await this.changeEnergy(50);
  }

  async addAnniversary() {
    await this.changeEnergy(10);
  }

  async addAnswer() {
    await this.changeEnergy(100);
  }

  async addFollower() {
    await this.changeEnergy(200);
  }

  async addRoomInteraction(amount: number) {
    await this.changeEnergy(amount);
  }

  get getLiveCommentEnergyCursor(): number | null {
    return this.liveCommentEnergyCursor;
  }

  /** 初回起動時は既存コメントを加算せず、現在の末尾だけを基準点として保存する。 */
  async initializeLiveCommentEnergyCursor(commentId: number): Promise<void> {
    if (this.liveCommentEnergyCursor !== null) return;
    this.liveCommentEnergyCursor = commentId;
    await MemoryService.updateBiorhythmState({
      energy: this.energy,
      mood: this.moodPrev,
      mood_en: this.moodPrevEn,
      status: this.status,
      liveCommentEnergyCursor: this.liveCommentEnergyCursor,
    });
  }

  /** コメント分の加算とカーソル更新を同じ biorhythm 状態保存に含める。 */
  async addLiveCommentEnergy(amount: number, throughCommentId: number): Promise<void> {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Invalid live comment energy amount: ${amount}`);
    }
    if (!Number.isSafeInteger(throughCommentId) || throughCommentId < 0) {
      throw new Error(`Invalid live comment cursor: ${throughCommentId}`);
    }
    if (
      this.liveCommentEnergyCursor !== null
      && throughCommentId <= this.liveCommentEnergyCursor
    ) {
      return;
    }
    this.liveCommentEnergyCursor = throughCommentId;
    await this.changeEnergy(amount, {
      liveCommentEnergyCursor: this.liveCommentEnergyCursor,
    });
  }

  get getEnergy(): number { return this.energy / 100; }
  get getMood(): string { return this.moodPrev; }
  get getMoodEn(): string { return this.moodPrevEn; }

  get generatedImage(): Buffer | null {
    return this._generatedImage;
  }

  async refreshDailyTopPost() {
    try {
      // 公開ダッシュボードは定期投稿の設定に影響されず、常に両ネットワークから選ぶ。
      const candidate = await getDailyTopPostCandidate(DASHBOARD_TOP_POST_SOURCE);
      await MemoryService.updateTopPost(
        candidate ? toDashboardTopPost(candidate) : null,
      );
      this.emit('statsChange', await this.getCurrentState());
    } catch (error) {
      // 一時的なDB/API障害では、直前に正常取得できた表示を維持する。
      console.error("[ERROR][BIO] Failed to refresh daily top post:", error);
    }
  }

  /**
   * Bluesky の現在フォロワー数。日次のおやすみポストでも取得しているが、それだと
   * ダッシュボードの「現在のフォロワー」が最大24時間古くなるので、ここでも回す。
   */
  async updateFollowerCount() {
    const actor = process.env.BSKY_DID;
    if (!actor) return;
    try {
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const profile = (await response.json()) as { followersCount?: number };
      if (typeof profile.followersCount === "number") {
        this.currentFollowers = profile.followersCount;
        await MemoryService.setBotState("last_follower_count", profile.followersCount);
      }
    } catch (error) {
      console.error("[ERROR][BIO] Failed to refresh follower count:", error);
    }
  }

  private async getNagiStatsCached(): Promise<NagiStats> {
    if (this.nagiStatsCache && Date.now() - this.nagiStatsCache.at < NAGI_STATS_TTL_MS) {
      return this.nagiStatsCache.value;
    }
    const value = await MemoryService.getNagiStats();
    this.nagiStatsCache = { at: Date.now(), value };
    return value;
  }

  private async getRepoWritePointsCached(): Promise<RepoWritePointUsage> {
    if (
      this.repoWritePointsCache &&
      Date.now() - this.repoWritePointsCache.at < REPO_WRITE_POINTS_TTL_MS
    ) {
      return this.repoWritePointsCache.value;
    }
    const value = await MemoryService.getRepoWritePointUsage(process.env.BSKY_DID);
    this.repoWritePointsCache = { at: Date.now(), value };
    return value;
  }

  private async getMemoryImpressionsCached(): Promise<RecentBotMemoryImpression[]> {
    if (
      this.memoryImpressionsCache &&
      Date.now() - this.memoryImpressionsCache.at < MEMORY_IMPRESSIONS_TTL_MS
    ) {
      return this.memoryImpressionsCache.value;
    }
    try {
      const value = await getRecentBotMemoryImpressions(20);
      this.memoryImpressionsCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      // 補助表示の失敗でダッシュボード全体のsnapshotを落とさない。
      console.error("[ERROR][BIO] Failed to load recent memory impressions:", error);
      return this.memoryImpressionsCache?.value ?? [];
    }
  }

  async getCurrentState(): Promise<BotStat> {
    const dailyStats = await MemoryService.getDailyStats();
    const totalStats = await MemoryService.getTotalStats();
    const nagiStats = await this.getNagiStatsCached();
    const repoWritePoints = await this.getRepoWritePointsCached();
    const topPost = await MemoryService.getTopPost();
    const memoryImpressions = await this.getMemoryImpressionsCached();

    const now = new Date();
    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    // Convert lang Map to array safely
    const langArray: [LanguageName, number][] = dailyStats.lang instanceof Map
      ? Array.from(dailyStats.lang.entries())
      : [];

    return {
      energy: this.getEnergy,
      mood: this.getMood,
      mood_en: this.getMoodEn,
      status: this.status,
      dailyStats: {
        ...dailyStats,
        lang: langArray,
      },
      totalStats: {
        ...totalStats,
      },
      utilities: UtilityAI.getUtilities({
        hour,
        isWeekend,
        energy: this.getEnergy,
        currentAction: this.moodPrev
      }),
      nextStepTime: this.nextStepTime,
      bsky: { currentFollowers: this.currentFollowers },
      nagi: nagiStats,
      repoWritePoints,
      health: getCachedHealthSnapshot(),
      topPost,
      memoryImpressions,
    };
  }

  // --------
  // メインループ
  // --------
  async step() {
    this.statusPrev = this.status;
    this.energyPrev = this.energy;
    this.timePrev = new Date().toISOString();

    const now = new Date();
    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    // 未読のリプライ取得
    const unreadReply = await MemoryService.getUnreadReplies();

    // お部屋で起きたできごと。誰が来て何をしてくれたかを行動生成に反映する。
    const roomEvents = await MemoryService.getUnreadRoomEvents();
    const roomEventsForPrompt = await this.resolveRoomEvents(roomEvents);

    // 新しいステータス候補を決定
    const nextStatus = UtilityAI.selectAction({
      hour,
      isWeekend,
      energy: this.getEnergy,
      currentAction: this.moodPrev
    });

    // その日まだおはようを言っていないときにSleepから他の状態へ遷移する場合、必ずWakeUpを経由させる。
    // 時刻ではなく「おはよう未投稿か」で見るのは、おはようポスト側も時刻の窓を持たないため。
    // 条件がずれると、起床ポストをしながら mood は勉強中、といった食い違いが起きる。
    if (this.status === "Sleep" && nextStatus !== "Sleep" && this.canPostGoodMorning()) {
      this.status = "WakeUp";
    } else {
      this.status = nextStatus;
    }

    // 天候取得
    const weather = await getYokohamaWeather();

    // RPDチェック: 超過時は全処理スキップし、丸1日後に再実行
    if (!(await MemoryService.checkRPD())) {
      console.log(`[INFO][BIORHYTHM] RPD exceeded, skipping step.`);
      const nextInterval = 24 * 60 * 60 * 1000;
      await this.scheduleNextStep(nextInterval);
      this.emit('statsChange', await this.getCurrentState());
      return;
    }

    // 今日の予定表。bot日が変わったときだけ Gemini を1回叩く（内部で作品リストも週1で更新）。
    // 失敗しても undefined が返るだけで、その場合は予定なしの従来プロンプトで生成する。
    const plan = await ensureDailyPlan({
      isWeekend,
      eventSamples: this.eventSamplesForPlan(),
    }).catch((error) => {
      console.error("[ERROR][BIORHYTHM] ensureDailyPlan threw:", error);
      return undefined;
    });

    let duration_minutes = 60;
    let nextInterval = DEFAULT_STEP_INTERVAL_MS;
    let nextStepSaved = false;

    try {
      const result = await this.resolveStatus({
        plan,
        isWeekend,
        weather,
        unreadReply,
        roomEvents: roomEventsForPrompt,
        utilities: UtilityAI.getUtilities({
          hour,
          isWeekend,
          energy: this.getEnergy,
          currentAction: this.moodPrev,
        }),
      });
      const status_text = result.status_text;
      const status_text_en = result.status_text_en;
      duration_minutes = result.duration_minutes;

      // 次回スケジュール（AIが決めた時間、ただし最小5分、最大180分とする）
      const duration = Math.max(5, Math.min(duration_minutes, 180));
      nextInterval = process.env.NODE_ENV === "development" ? 5 * 60 * 1000 :
        duration * 60 * 1000;
      this.nextStepTime = getNextStepTime(nextInterval);
      await this.setOutput(status_text, status_text_en);
      nextStepSaved = true;

      // 活動ログをDBに保存
      await MemoryService.addBiorhythmHistory(this.status, status_text, status_text_en, Math.round(this.getEnergy));

      // 定期ポストへ渡す記憶。bot-runtime の getBotContext() は TTL 5分キャッシュを持つので
      // ここでは使わない。setOutput() の直後に今の値から組み立てないと、「いまやってること」
      // だけ1世代古くなって、まさにこれから潰したい矛盾を自分で作ってしまう。
      const botContext = buildBiorhythmBotContext({
        mood: status_text,
        moodEn: status_text_en,
        energy: this.getEnergy,
        weather,
        history: await MemoryService.getBiorhythmHistorySince(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
        ),
      });

      // 生成に成功したぶんだけ既読にする。ここが catch の中ではなく後ろにあるのは意図的で、
      // LLM が失敗した回のできごとは次の step に持ち越したいため（未読リプライと違い、
      // お部屋のできごとを取りこぼすと来てくれた人の体験がそのまま消える）。
      await MemoryService.markRoomEventsRead(roomEvents.map((event) => event.id));

      // おやすみポスト
      if (this.firstStepDone) {
        if (this.status !== this.statusPrev && this.status === "Sleep" && (hour >= 21 || hour <= 3)) {
          if (this.canPostGoodNight()) {
            console.log(`[INFO][BIORHYTHM] post goodnight!`);
            await postGoodNight(this.getMood, botContext);
            await this.setGoodNightPostDate();
          } else {
            console.log(`[INFO][BIORHYTHM] goodnight post already done today, skipping`);
          }
        }
      }

      // おはようポスト。firstStepDone で抑えないのは、朝に再起動が挟まった日に撃ち漏らすため。
      // 二重投稿は canPostGoodMorning() と同じ bot 日ガード（shouldPostGoodMorning）が防ぐ。
      if (shouldPostGoodMorning({
        status: this.status,
        today: this.getAdjustedDateString(),
        lastGoodMorningPostDate: this.lastGoodMorningPostDate,
      })) {
        console.log(`[INFO][BIORHYTHM] post goodmorning!`);
        await postMorning(botContext);
        await this.changeEnergy(-6000);
        await this.setGoodMorningPostDate();
      }
      this.firstStepDone = true;

      // 定期つぶやきポスト。
      // おはようより先に出ないのは、両方が status !== "Sleep" を要求したうえで、おはようを
      // 撃った step では直前の changeEnergy(-6000) ＝ -60 によって定期つぶやきの下限60を
      // 割り込むから（エネルギーの上限が100なので、-60 したあと60以上は残りえない）。
      // この -60 は順序保証の一部でもある。
      if (shouldConsiderWhimsicalPost({
        status: this.status,
        energy: this.getEnergy,
        lastGoodNightPostDate: this.lastGoodNightPostDate,
        lastGoodMorningPostDate: this.lastGoodMorningPostDate,
        isDevelopment: process.env.NODE_ENV === "development",
      })) {
        const probability = Math.random() * 100;
        if (probability < this.getEnergy || process.env.NODE_ENV === "development") {
          console.log(`[INFO][BIORHYTHM] post and decrease energy!`);
          await postWhimsical(this.getMood, botContext);
          await this.changeEnergy(-6000);
        }
      }

      this.getCurrentState().then(state => this.emit('statsChange', state));
    } catch (e) {
      // エラー時はスキップする
      console.error(e);
    }

    // エネルギー変動処理: Energyは完全にユーザインタラクトベースとするのでコメントアウト
    // this.handleEnergyByStatus();

    // ログ出力
    console.log(`[INFO][BIORHYTHM] status: ${this.status}, energy: ${this.getEnergy}, roomEvents: ${roomEvents.length}, action: ${this.getMood}, next: ${duration_minutes} min`);

    // リプライ既読処理
    await MemoryService.markRepliesRead();

    if (nextStepSaved) {
      this.armStepTimer(getStartupStepDelayMs(this.nextStepTime));
    } else {
      await this.scheduleNextStep(nextInterval);
    }
  }

  /** できごとに出てくる did の表示名をまとめて解決する。同じ人が複数回来ていても1回で済ませる。 */
  private async resolveRoomEvents(events: RoomEvent[]): Promise<RoomEventForPrompt[]> {
    if (events.length === 0) return [];
    const dids = [...new Set(events.map((event) => event.did))];
    const names = await Promise.all(dids.map((did) => fetchDisplayName(did)));
    return toRoomEventsForPrompt(events, new Map(dids.map((did, i) => [did, names[i]!])));
  }

  /** 日次予定表を立てるときの雰囲気の参考。これまで各stepに丸ごと渡していた例文を1日1回に移した。 */
  private eventSamplesForPlan(): Record<string, unknown> {
    const isWeekend = [0, 6].includes(new Date().getDay());
    return {
      WakeUp: isWeekend ? eventsMorningDayoff : eventsMorningWorkday,
      Study: isWeekend ? eventsNoonDayoff : eventsNoonWorkday,
      FreeTime: isWeekend ? eventsEveningDayoff : eventsEveningWorkday,
      Relax: eventsNight,
      Sleep: eventsMidnight,
    };
  }

  /**
   * 状況描写を得る。
   *
   * 予定表があるときはそれをプロンプトに足す。足さないと、その日の筋書き（服装・同行者・作品名）
   * から外れた描写になり、記憶の中で1日が途切れる。
   *
   * 行動時間は予定表の値を優先する。「botたん自身の意志で行動時間が決まる」性質は、
   * 予定を立てる時点（1日1回）で本人が決めておくことで担保している。
   * 予定が無い日は従来どおりモデルの返す duration_minutes を使う。
   */
  private async resolveStatus(input: {
    plan: DailyPlan | undefined;
    isWeekend: boolean;
    weather: string;
    unreadReply?: string[];
    utilities: Record<Status, number>;
    roomEvents: RoomEventForPrompt[];
  }): Promise<{
    status_text: string;
    status_text_en: string;
    duration_minutes: number;
  }> {
    // 予定を引いてからプロンプトを組む。takePlannedEvent は候補からの乱択なので、
    // 「予定があるか」を知るために先に一度呼んで結果を使い回すこと（二度引くと別の予定になる）。
    const picked = takePlannedEvent(input.plan, this.status);
    const result = await this.generateStatus(
      this.buildPrompt(
        getFullDateAndTimeString(),
        input.isWeekend,
        input.weather,
        input.unreadReply,
        input.utilities,
        input.roomEvents,
        Boolean(picked),
      ) + buildPlannedEventSection(input.plan, picked?.event),
    );
    if (input.plan && picked) {
      // 消化を記録するのは生成に成功した回だけ。失敗した回の予定は次の step に残す。
      await markPlannedEventUsed(input.plan, picked.index);
      return { ...result, duration_minutes: picked.event.durationMinutes };
    }
    return result;
  }

  private buildPrompt(timeNow: string, isWeekend: Boolean, weather: string, unreadReply?: string[], utilities?: Record<Status, number>, roomEvents: RoomEventForPrompt[] = [], hasPlannedEvent = false): string {
    const outfitInstruction = (this.status === "WakeUp" || !this.moodPrev)
      ? `今日の服装を自由に選んでください（ミント色のカーディガン以外のものも積極的に選ぶこと）。`
      : `服装は前回から変わっていないため、服装の描写は不要です。`;

    // キャラクター設定は generateStatus 側で systemInstruction として渡す。
    // ここに埋め込むとユーザ入力の一部として扱われ、モデルが設定文の文体に引っ張られる。
    return `
以下のキャラクター（System Instruction に設定されている「全肯定botたん」）の行動を描写してほしいです。
このキャラクターが現在どんな気分でなにをしているか、現在時刻・天候・ステータス・行動欲求・前回した行動・お部屋でのできごとをもとにして、具体的に考えてください。
* ルール
- 結果はJSON形式で出力してください。
- "status_text": 「全肯定たんは～しています」という、AIに入力する平易なプロンプト文（200文字以内）。服装について：${outfitInstruction}
- "status_text_en": status_text の英語訳（plain English, max 200 characters）。
- "duration_minutes": その行動にかかる時間（分）。行動の内容に合わせて5分から90分の範囲内で適切に決めてください。
- ステータスについて、WakeUpは起床時、Studyは勉強中、FreeTimeは余暇時間、Relaxは休憩中、Sleepは就寝中(夢の中)を意味します。
- 重要: status_textは必ず現在のステータス（${this.status}）に合った行動を描写すること。Sleepなら就寝・夢の中、Studyなら勉強中、FreeTimeなら余暇活動、Relaxなら休憩、WakeUpなら起床直後の行動のみとすること。
- 重要: クラスメイトはことみちゃんだけ。ラテちゃんは学校・教室・授業・校庭には登場させず、放課後や休日など学校の外だけで交流させること。
- 重要: モルフォは学校へ連れて行かない。学校・教室・授業・校庭の場面には、モルフォを絶対に登場させないこと。
- 重要: 「お部屋でのできごと」に gift（プレゼント）がある場合は、現在のステータスに合う形で、必ずその贈り物への言及を status_text に入れること。Sleep中なら夢に出てくる、といった扱いにすればよい。
- 行動欲求は、あなたがどの行動をしたいか、です。たとえばSleepが一番高いのに、ステータスがFreeTimeの場合、眠いのに遊んでいる状態です。
- 以下の日にはその日にふさわしい行動をさせること
  * 元旦 (1月1日)
  * 節分 (2月3日)
  * バレンタイン (2月14日)
  * ホワイトデー (3月14日)
  * エイプリルフール (4月1日)
  * 母の日
  * 父の日
  * 七夕 (7月7日)
  * ハロウィン (10月31日)
  * クリスマス (12月25日)
  * 大晦日 (12月31日)
${hasPlannedEvent ? "" : `-----行動参考例-----
* 以下がキャラクターの行動例です。
${this.status === "WakeUp" ? isWeekend ? `${JSON.stringify(eventsMorningDayoff)}` : `${JSON.stringify(eventsMorningWorkday)}` :
        this.status === "Study" ? isWeekend ? `${JSON.stringify(eventsNoonDayoff)}` : `${JSON.stringify(eventsNoonWorkday)}` :
          this.status === "FreeTime" ? isWeekend ? `${JSON.stringify(eventsEveningDayoff)}` : `${JSON.stringify(eventsEveningWorkday)}` :
            this.status === "Relax" ? `${JSON.stringify(eventsNight)}` :
              this.status === "Sleep" ? `${JSON.stringify(eventsMidnight)}` : ""
      }`}
* 以下がユーザーからもらったコメントです。次の行動を考える際に参考にすること。
${JSON.stringify(unreadReply)}
${buildRoomEventsSection(roomEvents)}

-----以下がキャラクターの状態-----
・現在
現在時刻：${timeNow}
天候：${weather}
ステータス：${this.status}
体力気力（0～100）：${this.getEnergy}
行動欲求：${JSON.stringify(utilities)}
・前回
前回時刻：${this.timePrev}
ステータス：${this.statusPrev}
体力気力（0～100）：${this.energyPrev / 100}
前回した行動：${this.moodPrev}
`;
  }

  private async generateStatus(prompt: string): Promise<{ status_text: string, status_text_en: string, duration_minutes: number }> {
    const response = await generateContentWithRetry({
      feature: 'BIORHYTHM_STATUS',
      contents: prompt,
      config: {
        // ペルソナはシステムターンに置く（ユーザ入力として扱わせない）。
        // 全文（SYSTEM_INSTRUCTION、約4,500字）ではなく描写用ブリーフを使う。status_text は
        // 「全肯定たんは〜しています」という三人称の描写文で、botたん自身の発話ではないため
        // 口調ルールを当てると壊れる＝もともと全文はオーバースペックだった。
        // ここは1日24〜48回走るので、載せる文字数がそのまま従量に効く。
        systemInstruction: BOT_SCENE_BRIEF_JA,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            status_text: { type: Type.STRING },
            status_text_en: { type: Type.STRING },
            duration_minutes: { type: Type.INTEGER },
          },
          required: ["status_text", "status_text_en", "duration_minutes"],
        },
      }
    }, 3, undefined, {
      // 機能別のコストは今まで誰も測っていなかった。ここが本当に主因なのか、
      // 実は Nagi のリプライの方が大きいのかを後から判断できるよう1行残す。
      onUsage: (usage) =>
        console.log(
          `[INFO][BIORHYTHM] status usage: model=${usage.model} tier=${usage.serviceTier ?? "-"} in=${usage.promptTokens} out=${usage.outputTokens} think=${usage.thinkingTokens} ms=${usage.latencyMs}`,
        ),
    });

    // 空を握り潰して返すと、mood が空のまま「生成成功」として扱われ、
    // お部屋のできごとまで既読になって消える。失敗として扱い次の step に持ち越す。
    if (!response.text) {
      throw new Error("generateStatus returned an empty response");
    }

    const result = JSON.parse(response.text);
    if (!result.status_text) {
      throw new Error("generateStatus returned an empty status_text");
    }

    return result;
  }

  private async changeEnergy(amount: number, statePatch: Record<string, unknown> = {}) {
    // 0~100クリップ処理
    const newEnergy = Math.max(Math.min(this.energy + amount, ENERGY_MAXIMUM), 0);

    if (newEnergy !== this.energy || Object.keys(statePatch).length > 0) {
      this.energy = newEnergy;
      // this.emit('statsChange', this.getCurrentState()); // getCurrentState is async
      this.getCurrentState().then(state => this.emit('statsChange', state));
      await MemoryService.updateBiorhythmState({
        energy: this.energy,
        mood: this.moodPrev,
        mood_en: this.moodPrevEn,
        status: this.status,
        ...(this.liveCommentEnergyCursor === null
          ? {}
          : { liveCommentEnergyCursor: this.liveCommentEnergyCursor }),
        ...statePatch,
      });
    }
  }

  private async setOutput(newOutput: string, newOutputEn: string) {
    this.moodPrev = newOutput;
    this.moodPrevEn = newOutputEn;
    this.getCurrentState().then(state => this.emit('statsChange', state));
    await MemoryService.updateBiorhythmState({
      energy: this.energy,
      mood: this.moodPrev,
      mood_en: this.moodPrevEn,
      status: this.status,
      nextStepTime: this.nextStepTime,
      ...(this.liveCommentEnergyCursor === null
        ? {}
        : { liveCommentEnergyCursor: this.liveCommentEnergyCursor }),
    });
  }

  private async handleEnergyByStatus() {
    // if (this.status !== this.statusPrev) {
    //   // 遷移した場合だけ処理
    //   if (this.status === 'Sleep') {
    //     this.energy = Math.max(this.energy - 2000, 0);
    //   }
    // }

    // 状態にかかわらず、現在の行動によるランダム変動（継続状態でも発生）
    // if (this.status === 'Study') {
    //   this.energy += Math.floor(Math.random() * 1100) - 500; // -500 ~ +500
    // } else if (this.status === 'FreeTime') {
    //   this.energy += Math.floor(Math.random() * 900) + 200; // +200 ~ +1000
    // }

    // 範囲を保証
    const newEnergy = Math.max(0, Math.min(ENERGY_MAXIMUM, this.energy));
    if (newEnergy !== this.energy) {
      this.energy = newEnergy;
      await MemoryService.updateBiorhythmState({
        energy: this.energy,
        mood: this.moodPrev,
        mood_en: this.moodPrevEn,
        status: this.status,
        ...(this.liveCommentEnergyCursor === null
          ? {}
          : { liveCommentEnergyCursor: this.liveCommentEnergyCursor }),
      });
    }
  }

  private getAdjustedDateString(): string {
    return botDayRange().date;
  }

  private canPostGoodNight(): boolean {
    const today = this.getAdjustedDateString();
    return this.lastGoodNightPostDate !== today;
  }

  private async setGoodNightPostDate() {
    const today = this.getAdjustedDateString();
    this.lastGoodNightPostDate = today;
    await MemoryService.updateBiorhythmState({ lastGoodNightPostDate: today });
  }

  private canPostGoodMorning(): boolean {
    const today = this.getAdjustedDateString();
    return this.lastGoodMorningPostDate !== today;
  }

  private async setGoodMorningPostDate() {
    const today = this.getAdjustedDateString();
    this.lastGoodMorningPostDate = today;
    await MemoryService.updateBiorhythmState({ lastGoodMorningPostDate: today });
  }
}
