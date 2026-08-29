import { MemoryService } from "@bsky-affirmative-bot/clients";
import {
  getDailyPlanMemoryImpressions,
  markDailyPlanMemoryImpressionsUsed,
  type DailyPlanMemoryImpression,
} from "@bsky-affirmative-bot/database";
import { generateContentWithRetry } from "@bsky-affirmative-bot/bot-brain";
import {
  BOT_TASTE_BRIEF_JA,
  SYSTEM_INSTRUCTION,
  botDayRange,
  getWhatDayForCalendarDate,
  getWeekdayJaForCalendarDate,
  type Status,
} from "@bsky-affirmative-bot/shared-configs";
import { Type } from "@google/genai";
import {
  buildSeasonalWorksSection,
  ensureSeasonalWorks,
  markSeasonalWorksUsed,
  normalizeForMatch,
  findGenericMediaEvents,
} from "./seasonalWorks.js";
import {
  buildMemoryImpressionsSection,
  selectDailyMemoryImpressions,
} from "./botMemoryImpressions.js";

/**
 * botたんの「今日の予定表」。
 *
 * 各 step の描写はローカルの小型モデルが担当するが、4b モデルに「誰と何をするか」まで
 * 決めさせるとキャラクターが持たない。そこで1日1回だけ Gemini に筋書きを立てさせ、
 * step 側は「その予定を描写するだけ」にする。
 *
 * duration_minutes をここで決めるのも要点。step ごとの小型モデルに数値を出させると
 * パースが不安定になるが、「botたん自身の意志で行動時間が決まる」という性質は崩したくない。
 * 予定表を立てる時点で botたん（Gemini）が決めておけば、両方を満たせる。
 */
export const DAILY_PLAN_STATE_KEY = "biorhythm_daily_plan_v3";

/** 予定表が扱うステータス。Sleep も夢の描写があるので含める。 */
const PLANNED_STATUSES: Status[] = ["WakeUp", "Study", "FreeTime", "Relax", "Sleep"];

const EVENTS_PER_STATUS = 5;
const MIN_DURATION = 5;
const MAX_DURATION = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 「ひとり」、各1人、各2人組、3人全員のすべての組み合わせ。 */
export const DAILY_COMPANION_OPTIONS = [
  "ひとり",
  "ことみちゃん",
  "ラテちゃん",
  "モルフォ",
  "ことみちゃん・ラテちゃん",
  "ことみちゃん・モルフォ",
  "ラテちゃん・モルフォ",
  "ことみちゃん・ラテちゃん・モルフォ",
] as const;

/**
 * 固定周期にはせず、その日に一緒に過ごす組み合わせをランダムに選ぶ。
 * 保存済みプランがちょうど前日なら完全に同じ組み合わせだけを候補から外す。
 * 一部の相手が前日と重なることは許す。
 */
export function selectDailyCompanion(
  botDate: string,
  previousPlan?: Pick<DailyPlan, "botDate" | "companion">,
  random: () => number = Math.random,
): string {
  const timestamp = Date.parse(`${botDate}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid bot date: ${botDate}`);
  const previousTimestamp = previousPlan
    ? Date.parse(`${previousPlan.botDate}T00:00:00Z`)
    : Number.NaN;
  const previousCompanion =
    Number.isFinite(previousTimestamp) && timestamp - previousTimestamp === DAY_MS
      ? previousPlan?.companion
      : undefined;
  const candidates = DAILY_COMPANION_OPTIONS.filter(
    (companion) => companion !== previousCompanion,
  );
  return candidates[Math.floor(random() * candidates.length)] ?? candidates[0];
}

export interface PlannedEvent {
  status: Status;
  activity: string;
  durationMinutes: number;
}

export interface DailyPlan {
  botDate: string;
  outfit: string;
  companion: string;
  moodDirection: string;
  events: PlannedEvent[];
  /** 消化済みイベントの events 内インデックス。 */
  usedEventIds: number[];
  /** 直前に選んだイベント。同じ行動を2回続けて描写しないためだけに持つ。 */
  lastEventIndex?: number;
}

const clampDuration = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 30;
  return Math.max(MIN_DURATION, Math.min(Math.round(numeric), MAX_DURATION));
};

const isStatus = (value: unknown): value is Status =>
  typeof value === "string" && (PLANNED_STATUSES as string[]).includes(value);

/**
 * Gemini の構造化 JSON をプランへ落とす。
 * events が空のときは undefined を返し、呼び出し側は従来の Gemini 毎 step 生成へ落ちる。
 */
export function parseDailyPlan(raw: unknown, botDate: string): DailyPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const events: PlannedEvent[] = Array.isArray(value.events)
    ? value.events
        .filter(
          (event): event is Record<string, unknown> =>
            Boolean(event) && typeof event === "object",
        )
        .filter(
          (event) => isStatus(event.status) && typeof event.activity === "string",
        )
        .map((event) => ({
          status: event.status as Status,
          activity: String(event.activity).trim(),
          durationMinutes: clampDuration(event.durationMinutes),
        }))
        .filter((event) => event.activity.length > 0)
    : [];
  if (events.length === 0) return undefined;

  return {
    botDate,
    outfit: typeof value.outfit === "string" ? value.outfit.trim() : "",
    companion: typeof value.companion === "string" ? value.companion.trim() : "",
    moodDirection:
      typeof value.moodDirection === "string" ? value.moodDirection.trim() : "",
    events,
    usedEventIds: [],
  };
}

export function isPlanFresh(
  plan: DailyPlan | undefined,
  botDate: string,
): boolean {
  return Boolean(plan && plan.botDate === botDate && plan.events.length > 0);
}

/**
 * ステータスに合う予定を1件取り出す。
 *
 * UtilityAI の行動選択はエネルギー依存の Softmax なので時刻固定のスケジュールは組めない。
 * 予定表は「ステータス別のプール」として持ち、選ばれたステータスに合うものをここで引く。
 *
 * 未消化が尽きたら消化済みを再利用する（1日の step 数はステータスの偏り次第で読めないため）。
 * ただし直前に選んだものは避ける。同じ描写が2回続くと記憶としても不自然になる。
 * 直前の判定に moodPrev（生成された描写文）を使わないのは、描写は予定文そのままではなく
 * 語尾も語彙も変わっているため。文字列一致では当たらないので、インデックスで持つ。
 */
export function takePlannedEvent(
  plan: DailyPlan | undefined,
  status: Status,
): { event: PlannedEvent; index: number } | undefined {
  if (!plan) return undefined;
  const used = new Set(plan.usedEventIds);
  const matching = plan.events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.status === status);
  if (matching.length === 0) return undefined;

  const unused = matching.filter((entry) => !used.has(entry.index));
  const pool = unused.length > 0 ? unused : matching;
  // 直前と同じ予定を避ける。候補がそれしか無ければ諦めてそのまま返す。
  const distinct = pool.filter((entry) => entry.index !== plan.lastEventIndex);
  const candidates = distinct.length > 0 ? distinct : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Gemini フォールバック側のプロンプトへ足す、今日の予定のブロック。
 *
 * buildPrompt は予定表を知らないので、これが無いとローカルが落ちた回だけ今日の筋書き
 * （服装・同行者・作品）から外れた描写になり、記憶の中で1日が途切れる。
 */
export function buildPlannedEventSection(
  plan: DailyPlan | undefined,
  event: PlannedEvent | undefined,
): string {
  if (!plan || !event) return "";
  return `
-----今日の予定-----
* 今日1日ぶんの筋書きです。status_text はこの予定を描写に起こしてください。
  - 予定: ${event.activity}
  - 今日の主な同行者: ${plan.companion || "とくにいない"}
  - 今日の気分: ${plan.moodDirection || "ふつう"}
  - 主な同行者がすべての予定にいるとは限りません。予定に名前がない場面へ無理に登場させないこと。
  - **ラテちゃんはクラスメイトではありません。学校・教室・授業・校庭の場面には登場させず、放課後や休日など学校の外だけで交流させること。**
  - **モルフォは学校へ連れて行きません。学校・教室・授業・校庭の場面には絶対に登場させないこと。**
  - **予定に出てくる作品名・曲名・人の名前は、一般名詞に言い換えず、そのまま status_text に書くこと。**`;
}

const DAILY_PLAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    outfit: { type: Type.STRING, description: "今日の服装（1文）" },
    companion: {
      type: Type.STRING,
      description: `今日いっしょに過ごす相手の組み合わせ（${DAILY_COMPANION_OPTIONS.join(" / ")}）`,
    },
    moodDirection: { type: Type.STRING, description: "今日の気分の方向（1文）" },
    events: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          status: {
            type: Type.STRING,
            description: PLANNED_STATUSES.join(" / "),
          },
          activity: { type: Type.STRING, description: "具体的な予定（40文字以内）" },
          durationMinutes: { type: Type.INTEGER, description: "5〜90" },
        },
        required: ["status", "activity", "durationMinutes"],
      },
    },
  },
  required: ["outfit", "companion", "moodDirection", "events"],
};

export function buildDailyPlanPrompt(input: {
  botDate: string;
  isWeekend: boolean;
  companion: string;
  whatDay: string[];
  eventSamples: Record<string, unknown>;
  worksSection: string;
  memoryImpressionsSection?: string;
}): string {
  const [year, month, date] = input.botDate.split("-").map(Number);
  const weekday = getWeekdayJaForCalendarDate(year, month, date);
  return `全肯定botたんの「今日1日の予定」を立ててください。
各 step の細かい描写はこのあと別のAIが担当します。あなたはその素材になる骨組みだけを作ります。

今日: ${input.botDate}（${weekday}・${input.isWeekend ? "休日" : "平日"}）
今日はなんの日: ${JSON.stringify(input.whatDay)}

# 出力するもの
- "outfit": 今日の服装を1文で。毎日ちがう服を着るので、ミント色のカーディガン以外も積極的に選ぶこと。
- "companion": 日ごとの偏りを防ぐため、今日は必ず「${input.companion}」と出力すること。別の相手を選ばないこと。
- "moodDirection": 今日の気分の方向を1文で。
- "events": 今日ありうる行動の候補。**各ステータスにつき${EVENTS_PER_STATUS}件ずつ**、合計${PLANNED_STATUSES.length * EVENTS_PER_STATUS}件。
  - "status" は ${PLANNED_STATUSES.join(" / ")} のいずれか。WakeUpは起床時、Studyは勉強中、FreeTimeは余暇、Relaxは休憩、Sleepは就寝中（夢の中）。
  - "activity" はその行動を40文字以内で具体的に。「アニメを見る」ではなく何をどうするのかまで書く。
  - "durationMinutes" はその行動にかかる時間。行動の内容に合わせて${MIN_DURATION}〜${MAX_DURATION}分の範囲で、あなた自身が決めてください。

# ルール
- ステータスに合わない行動を混ぜないこと（Sleep は夢の中の出来事だけ、Study は勉強だけ）。
- 同じ行動を2回書かないこと。1日ぶんの幅が出るよう、屋内・屋外・ひとり・誰かと、をばらけさせること。
- companion は今日の「主な同行者の組み合わせ」であり、全25件の行動へ登場させる意味ではない。「ひとり」以外なら、companion に含まれる相手が登場する行動を合計3〜5件だけ作り、残りはひとりの行動にすること。
- companion に複数の相手が含まれる場合は、その全員が一緒に過ごす行動を少なくとも1件作ること。それ以外の同行者ありの行動では、一部の相手だけと過ごしてもよい。
- ことみちゃん・ラテちゃん・モルフォのうち、今日の companion に含まれない相手を行動へ登場させないこと。
- **クラスメイトはことみちゃんだけ。ラテちゃんは学校・教室・授業・校庭の行動には登場させず、放課後や休日など学校の外だけで交流させること。**
- **モルフォは学校へ連れて行かない。学校・教室・授業・校庭の行動には、companion がモルフォの日でも絶対にモルフォを登場させないこと。**
- 記念日が今日にあれば、そのうち1つか2つを行動に反映すること。

# 趣味
${BOT_TASTE_BRIEF_JA}

-----行動参考例-----
* 雰囲気の参考です。そのまま使わず、今日の予定として作り直してください。
${JSON.stringify(input.eventSamples)}
${input.worksSection}${input.memoryImpressionsSection ?? ""}`;
}

async function loadPlan(): Promise<DailyPlan | undefined> {
  const raw = await MemoryService.getBotState(DAILY_PLAN_STATE_KEY);
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<DailyPlan>;
  if (typeof value.botDate !== "string" || !Array.isArray(value.events)) {
    return undefined;
  }
  const plan = parseDailyPlan(value, value.botDate);
  if (!plan) return undefined;
  return {
    ...plan,
    usedEventIds: Array.isArray(value.usedEventIds)
      ? value.usedEventIds.filter((id): id is number => typeof id === "number")
      : [],
    ...(typeof value.lastEventIndex === "number"
      ? { lastEventIndex: value.lastEventIndex }
      : {}),
  };
}

export async function savePlan(plan: DailyPlan): Promise<void> {
  await MemoryService.setBotState(DAILY_PLAN_STATE_KEY, plan);
}

/** 消化済みを記録する。取り出しと分けているのは、生成に成功した回だけ消費したいため。 */
export async function markPlannedEventUsed(
  plan: DailyPlan,
  index: number,
): Promise<void> {
  if (!plan.usedEventIds.includes(index)) plan.usedEventIds.push(index);
  plan.lastEventIndex = index;
  await savePlan(plan);
}

/**
 * 今日の予定表。bot 日が変わっていれば作り直す。
 *
 * 生成に失敗しても投げない。前日のプランがあれば日付だけ差し替えて再利用し、
 * それも無ければ undefined を返す。呼び出し側は従来の Gemini 毎 step 生成へ落ちる。
 */
export async function ensureDailyPlan(
  input: { isWeekend: boolean; eventSamples: Record<string, unknown> },
  now: Date = new Date(),
): Promise<DailyPlan | undefined> {
  const botDate = botDayRange(now).date;
  const existing = await loadPlan();
  if (isPlanFresh(existing, botDate)) return existing;
  const companion = selectDailyCompanion(botDate, existing);

  try {
    const [works, memoryCandidates] = await Promise.all([
      ensureSeasonalWorks(now),
      getDailyPlanMemoryImpressions(now).catch((error) => {
        console.error("[WARN][BIORHYTHM] Failed to load memory impressions", error);
        return [] as DailyPlanMemoryImpression[];
      }),
    ]);
    const memoryImpressions = selectDailyMemoryImpressions(memoryCandidates, botDate);
    const [year, month, date] = botDate.split("-").map(Number);
    const basePrompt = buildDailyPlanPrompt({
      botDate,
      isWeekend: input.isWeekend,
      companion,
      whatDay: getWhatDayForCalendarDate(year, month, date),
      eventSamples: input.eventSamples,
      worksSection: buildSeasonalWorksSection(works, now),
      memoryImpressionsSection: buildMemoryImpressionsSection(memoryImpressions),
    });

    const generate = async (prompt: string) => {
      const response = await generateContentWithRetry({
        feature: "BIORHYTHM_DAILY_PLAN",
        // 予定表は25件のイベントを持つ JSON なので、投稿本文用の POST_TEXT_LIMIT（2100字）を
        // 平気で超える。これは暴走ではなく想定どおりの長さで、リトライしても縮まらないので外す。
        maxTextLength: null,
        contents: [prompt],
        config: {
          // ペルソナはシステムターンに置く。予定表は botたん自身の1日なので、口調ではなく
          // 趣味・交友関係が効いてほしい（TONE_RULES_JA は status_text 側で当てない方針と同じ）。
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: DAILY_PLAN_SCHEMA,
        },
      });
      const parsed = parseDailyPlan(JSON.parse(response.text || "{}"), botDate);
      // schema とプロンプトに加えてコード側でも固定し、モデルの選択バイアスを残さない。
      return parsed ? { ...parsed, companion } : undefined;
    };

    let plan = await generate(basePrompt);
    if (!plan) throw new Error("Daily plan had no usable events");

    // 「お気に入りのアニソンを聴きながら」のような一般名詞のままの予定が残ると、描写側は
    // それを情景に起こすだけなので固有名詞にしようがない。指示だけでは守られなかったので
    // 生成後に検査し、1回だけ直させる。1日1回の呼び出しなので追加コストは小さい。
    const memoryLabels = memoryImpressions.map((item) => item.label);
    const generic = findGenericMediaEvents(plan.events, works, memoryLabels);
    if (generic.length > 0) {
      console.warn(
        `[WARN][BIORHYTHM] Daily plan had ${generic.length} generic media event(s); retrying once: ` +
          generic.map((event) => event.activity).join(" / "),
      );
      const retried = await generate(
        `${basePrompt}

-----やり直しの指示-----
* 前回の予定表には、作品名の無い一般名詞だけの予定が残っていました:
${generic.map((event) => `  - ${event.activity}`).join("\n")}
* これらは「いま話題のもの」または「みんなとのやりとり」の候補から**具体的な名前を入れて書き直す**か、作品に触れない別の予定に差し替えてください。
* ほかの予定はそのままでかまいません。予定表全体をもう一度出力してください。`,
      );
      const stillGeneric = retried
        ? findGenericMediaEvents(retried.events, works, memoryLabels)
        : [];
      if (retried && stillGeneric.length <= generic.length) plan = retried;
      if (stillGeneric.length > 0) {
        console.warn(
          `[WARN][BIORHYTHM] ${stillGeneric.length} generic media event(s) remain after retry; keeping the plan`,
        );
      }
    }

    await savePlan(plan);
    // 予定に出た名前へ「使った」印を付ける。**正規化してから突き合わせること。**
    // 素の includes は大小文字と全角半角を区別するので、LLM が表記を変えた瞬間に
    // 印が付かない。実際 bot_memory_impressions は 2459件のうち last_used_at が
    // 1件しか入っておらず、14日のクールダウンが効いていなかった。
    const activities = plan.events.map((event) => normalizeForMatch(event.activity));
    const mentioned = (label: string) => {
      const needle = normalizeForMatch(label);
      return needle.length > 0 && activities.some((text) => text.includes(needle));
    };
    const usedImpressionIds = memoryImpressions
      .filter((item) => mentioned(item.label))
      .map((item) => item.id);
    await markDailyPlanMemoryImpressionsUsed(usedImpressionIds, now).catch((error) => {
      console.error("[WARN][BIORHYTHM] Failed to mark memory impressions used", error);
    });
    // 話題作にも同じ印を付ける。候補は種別ごとに数件しかないので、これが無いと
    // 同じ作品が7日のキャッシュのあいだ何度も予定に載る
    await markSeasonalWorksUsed(
      works.filter((work) => mentioned(work.title)).map((work) => work.title),
      now,
    ).catch((error) => {
      console.error("[WARN][BIORHYTHM] Failed to mark seasonal works used", error);
    });
    console.log(
      `[INFO][BIORHYTHM] Daily plan for ${botDate}: ${plan.events.length} events, companion=${plan.companion}`,
    );
    return plan;
  } catch (error) {
    console.error("[ERROR][BIORHYTHM] Failed to build daily plan:", error);
    if (!existing) return undefined;
    // 前日のプランを today として引き継ぐ。同じ服・同じ相手で1日過ごすことになるが、
    // プラン無しで全 step を Gemini に落とすよりは一貫性が保てる。
    const carried: DailyPlan = {
      ...existing,
      botDate,
      usedEventIds: [],
      lastEventIndex: undefined,
    };
    await savePlan(carried).catch(() => {});
    return carried;
  }
}
