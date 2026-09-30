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
  isJapaneseDayOff,
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
 * step ごとの描写で「誰と何をするか」まで毎回決めさせると、1日の筋書きがつながらない。
 * そこで1日1回だけ筋書きを立てさせ、step 側は「その予定を描写するだけ」にする。
 * どちらもモデルは aiRoutes の機能キーで決まる（本番は AI_TEXT_PROVIDER=ollama でローカル LLM）。
 *
 * duration_minutes をここで決めるのも要点。step ごとの小型モデルに数値を出させると
 * パースが不安定になるが、「botたん自身の意志で行動時間が決まる」という性質は崩したくない。
 * 予定表を立てる時点で botたんが決めておけば、両方を満たせる。
 */
// v5: 各予定に place / placeKind を持たせた。v4 の予定表は場所を持たないので読み捨てて作り直す。
export const DAILY_PLAN_STATE_KEY = "biorhythm_daily_plan_v5";

/** 予定表が扱うステータス。Sleep も夢の描写があるので含める。 */
const PLANNED_STATUSES: Status[] = ["WakeUp", "Study", "FreeTime", "Relax", "Sleep"];

/**
 * 予定を実行できる時間帯。
 *
 * UtilityAI は夜更かし傾向（FreeTime が22時ピーク）なので、同じステータスが夕方から深夜まで
 * 続く。予定表が時間帯を持たないと、カフェや買い物のような外出の予定が23時に引かれる
 * （2026-09-28 に実際に「23時にことみちゃんとカフェで新作スイーツ」を描写した）。
 * 時刻の範囲ではなく区分の列挙にしているのは、LLM に日付またぎの時刻を数値で出させると崩れるため。
 */
export const TIME_SLOTS = ["morning", "daytime", "evening", "night", "midnight"] as const;
export type TimeSlot = (typeof TIME_SLOTS)[number];

const TIME_SLOT_LABELS: Record<TimeSlot, string> = {
  morning: "4〜9時",
  daytime: "9〜17時",
  evening: "17〜21時",
  night: "21〜24時",
  midnight: "0〜4時",
};

/** JST の時（0〜23）が属する時間帯。 */
export function timeSlotForHour(hour: number): TimeSlot {
  if (hour >= 4 && hour < 9) return "morning";
  if (hour >= 9 && hour < 17) return "daytime";
  if (hour >= 17 && hour < 21) return "evening";
  if (hour >= 21) return "night";
  return "midnight";
}

const isTimeSlot = (value: unknown): value is TimeSlot =>
  typeof value === "string" && (TIME_SLOTS as readonly string[]).includes(value);

/**
 * 予定の場所の区分。場所の名前（place）は自由記述だが、「平日の日中は学校」をプロンプト任せに
 * せずコードで守るには区分が要る。以前は平日の昼に自宅でゲームをする描写が出ていた。
 */
export const PLACE_KINDS = ["school", "home", "outing"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

const isPlaceKind = (value: unknown): value is PlaceKind =>
  typeof value === "string" && (PLACE_KINDS as readonly string[]).includes(value);

/**
 * 学校にいるべき時間の縛りを受けるステータス。WakeUp（寝坊して昼に起きる）と
 * Sleep（夢の中）は場所を問わず成立するので外す。
 */
const SCHOOL_BOUND_STATUSES: ReadonlySet<Status> = new Set(["Study", "FreeTime", "Relax"]);

/**
 * おでかけ先の種類。step で予定を引くときの「出かけやすさ」を種類ごとに変える。
 *
 * - quietEasy: ひとりでも気軽に行ける（本屋・CDショップなど）。インドア派のおでかけ。
 * - quietEffort: ひとりでも行けるが、人と接する場面が多く敷居が高い。元気が要る。
 * - lively: にぎやかな遊び。誰かと一緒だと行きやすい。
 * - active: 屋外で体を動かす。元気が無いとまず行かない。
 */
export const OUTING_STYLES = ["quietEasy", "quietEffort", "lively", "active"] as const;
export type OutingStyle = (typeof OUTING_STYLES)[number];

/**
 * おでかけ先の候補と種類。その日の行き先はここからコードで振る。
 *
 * ローカルの 12B モデルに「いろんな場所へ」と頼んでも、自室・カフェ・公園に寄る。
 * 同行者と同じく、偏りはサイコロで崩す。季節を選ぶ場所（プール・スキー場など）は入れない。
 */
export const DAILY_OUTING_PLACE_STYLES = {
  アニメイト: "quietEasy",
  図書館: "quietEasy",
  本屋: "quietEasy",
  古本屋: "quietEasy",
  雑貨屋: "quietEasy",
  手芸店: "quietEasy",
  楽器屋: "quietEasy",
  パン屋: "quietEasy",
  駄菓子屋: "quietEasy",
  猫カフェ: "quietEasy",
  CDショップ: "quietEasy",
  レコード屋: "quietEasy",
  中古ゲーム屋: "quietEasy",
  文房具屋: "quietEasy",
  画材屋: "quietEasy",
  家電量販店: "quietEasy",
  喫茶店: "quietEffort",
  美術館: "quietEffort",
  博物館: "quietEffort",
  科学館: "quietEffort",
  プラネタリウム: "quietEffort",
  映画館: "quietEffort",
  遊園地: "lively",
  動物園: "lively",
  水族館: "lively",
  ゲームセンター: "lively",
  カラオケ: "lively",
  ボウリング場: "lively",
  ショッピングモール: "lively",
  商店街: "lively",
  クレープ屋: "lively",
  回転寿司: "lively",
  フリーマーケット: "lively",
  銭湯: "lively",
  野球場: "lively",
  河川敷: "active",
  海辺: "active",
  ハイキングコース: "active",
  植物園: "active",
  神社: "active",
  釣り堀: "active",
  牧場: "active",
  バッティングセンター: "active",
  聖地巡礼: "active",
} as const satisfies Record<string, OutingStyle>;

export const DAILY_OUTING_PLACES = Object.keys(DAILY_OUTING_PLACE_STYLES) as Array<
  keyof typeof DAILY_OUTING_PLACE_STYLES
>;

/** 「本屋」が「古本屋」の中で当たらないよう、長い名前から照合する。 */
const OUTING_PLACES_BY_LENGTH = [...DAILY_OUTING_PLACES].sort((a, b) => b.length - a.length);

/**
 * おでかけの予定がどの種類か。今日のおでかけ先を先に照合する
 * （「聖地巡礼」の予定は place が「〇〇の舞台の商店街」のようになりうるため）。
 * 一覧に無い身近な場所（コンビニ・近所の公園など）は quietEasy として扱う。
 */
export function outingStyleOf(
  event: Pick<PlannedEvent, "place" | "activity">,
  outingPlaces: readonly string[] = [],
): OutingStyle {
  const text = normalizeForMatch(`${event.place} ${event.activity}`);
  const styles: Record<string, OutingStyle> = DAILY_OUTING_PLACE_STYLES;
  for (const name of [...outingPlaces, ...OUTING_PLACES_BY_LENGTH]) {
    const style = styles[name];
    if (style && text.includes(normalizeForMatch(name))) return style;
  }
  return "quietEasy";
}

/**
 * おでかけの予定1件の重み。とどまる側（自宅・学校）は合計1に対する比で効く。
 *
 * botたんはインドア派なので、元気（energy）と同行者の有無で外出しやすさを変える。
 * energy は 15 以下で最小、50 以上で最大。本番の energy は 0〜60 にほぼ収まり、
 * 中央値は35前後（2026-09-30 時点・直近14日）なので、その幅で効くように置いている。
 *
 * とどまる予定1件とおでかけ1件を比べたときのおでかけ率（ひとり 低→高 / 同行者あり 低→高）:
 * - quietEasy:   29%→41% / 34%→48%
 * - quietEffort:  9%→38% / 13%→47%
 * - lively:       7%→32% / 19%→59%
 * - active:       3%→35% /  6%→52%
 */
const OUTING_WEIGHTS: Record<OutingStyle, { base: number; slope: number; companion: number }> = {
  quietEasy: { base: 0.4, slope: 0.3, companion: 1.3 },
  quietEffort: { base: 0.1, slope: 0.5, companion: 1.5 },
  lively: { base: 0.08, slope: 0.4, companion: 3 },
  active: { base: 0.03, slope: 0.5, companion: 2 },
};
const ENERGY_LOW = 15;
const ENERGY_HIGH = 50;

export function outingWeight(style: OutingStyle, energy: number, withCompanion: boolean): number {
  const t = Math.max(0, Math.min((energy - ENERGY_LOW) / (ENERGY_HIGH - ENERGY_LOW), 1));
  const weight = OUTING_WEIGHTS[style];
  return (weight.base + weight.slope * t) * (withCompanion ? weight.companion : 1);
}

const OUTING_PLACES_PER_DAY = 2;

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

/**
 * 今日のおでかけ先を振る。保存済みプランの行き先は（前日かどうかを問わず）候補から外す。
 * 保存しているプランは直近の1日分だけなので、連日同じ場所へ行くことだけを防げればよい。
 */
export function selectDailyOutingPlaces(
  previousPlan?: Pick<DailyPlan, "outingPlaces">,
  random: () => number = Math.random,
  count = OUTING_PLACES_PER_DAY,
): string[] {
  const previous = new Set(previousPlan?.outingPlaces ?? []);
  const pool: string[] = DAILY_OUTING_PLACES.filter((place) => !previous.has(place));
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.min(Math.floor(random() * pool.length), pool.length - 1);
    picked.push(...pool.splice(index, 1));
  }
  return picked;
}

export interface PlannedEvent {
  status: Status;
  activity: string;
  durationMinutes: number;
  /** この予定をやってもおかしくない時間帯。 */
  timeSlots: TimeSlot[];
  /** 具体的な場所の名前（例: 駅前の水族館）。描写の材料。 */
  place: string;
  placeKind: PlaceKind;
  /** その日の companion が登場する予定か。おでかけの出やすさに効く。 */
  withCompanion: boolean;
}

export interface DailyPlan {
  botDate: string;
  outfit: string;
  companion: string;
  /** コードで振った今日のおでかけ先。翌日の抽選で同じ場所を外すために持つ。 */
  outingPlaces: string[];
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

/**
 * 不正値や空配列は「いつでも可」として扱う。予定そのものを捨てるより、
 * 時間帯の制約が無い従来の挙動へ戻るほうが1日の筋書きを保てる。
 */
const parseTimeSlots = (value: unknown): TimeSlot[] => {
  const slots = Array.isArray(value) ? [...new Set(value.filter(isTimeSlot))] : [];
  return slots.length > 0 ? slots : [...TIME_SLOTS];
};

const isStatus = (value: unknown): value is Status =>
  typeof value === "string" && (PLANNED_STATUSES as string[]).includes(value);

/**
 * モデルの構造化 JSON をプランへ落とす。
 * events が空のときは undefined を返し、呼び出し側は予定なしの step 生成へ落ちる。
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
          timeSlots: parseTimeSlots(event.timeSlots),
          place: typeof event.place === "string" ? event.place.trim() : "",
          // 区分が読めない予定は outing として扱う。平日の日中には引かれない側へ倒れる。
          placeKind: isPlaceKind(event.placeKind) ? event.placeKind : "outing",
          withCompanion: event.withCompanion === true,
        }))
        .filter((event) => event.activity.length > 0)
    : [];
  if (events.length === 0) return undefined;

  return {
    botDate,
    outfit: typeof value.outfit === "string" ? value.outfit.trim() : "",
    companion: typeof value.companion === "string" ? value.companion.trim() : "",
    outingPlaces: Array.isArray(value.outingPlaces)
      ? value.outingPlaces.filter((place): place is string => typeof place === "string")
      : [],
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
 * ステータスと時刻に合う予定を1件取り出す。
 *
 * UtilityAI の行動選択はエネルギー依存の Softmax なので時刻固定のスケジュールは組めない。
 * 予定表は「ステータス別のプール」として持ち、選ばれたステータスに合うものをここで引く。
 *
 * 未消化が尽きたら消化済みを再利用する（1日の step 数はステータスの偏り次第で読めないため）。
 * ただし直前に選んだものは避ける。同じ描写が2回続くと記憶としても不自然になる。
 * 直前の判定に moodPrev（生成された描写文）を使わないのは、描写は予定文そのままではなく
 * 語尾も語彙も変わっているため。文字列一致では当たらないので、インデックスで持つ。
 *
 * 時間帯と場所は使い回しのときも外さない。今に合う予定が1件も無ければ undefined を返し、
 * 呼び出し側は予定なしのプロンプト（時間帯ごとの行動例つき）で描写する。
 *
 * 自宅・学校とおでかけの両方が候補にあるときは、energy と同行者で重みを付ける
 * （pickWeightedEvent 参照）。
 */
export function takePlannedEvent(
  plan: DailyPlan | undefined,
  status: Status,
  hour: number,
  isDayOff: boolean,
  energy: number,
  random: () => number = Math.random,
): { event: PlannedEvent; index: number } | undefined {
  if (!plan) return undefined;
  const slot = timeSlotForHour(hour);
  const used = new Set(plan.usedEventIds);
  const matching = plan.events
    .map((event, index) => ({ event, index }))
    .filter(
      (entry) =>
        entry.event.status === status &&
        entry.event.timeSlots.includes(slot) &&
        isPlaceAllowed(entry.event, slot, isDayOff),
    );
  if (matching.length === 0) return undefined;

  const unused = matching.filter((entry) => !used.has(entry.index));
  const pool = unused.length > 0 ? unused : matching;
  // 直前と同じ予定を避ける。候補がそれしか無ければ諦めてそのまま返す。
  const distinct = pool.filter((entry) => entry.index !== plan.lastEventIndex);
  const candidates = distinct.length > 0 ? distinct : pool;
  return pickWeightedEvent(candidates, plan.outingPlaces, energy, random);
}

/**
 * とどまる側（自宅・学校）とおでかけ側を、まずどちらにするかで選び、次にその中から1件選ぶ。
 *
 * 2段にしているのは、LLM が書いた件数で比率が揺れないようにするため。とどまる側は合計1、
 * おでかけ側は各予定の重みの平均で比べるので、おでかけが3件あっても外出率は3倍にならない。
 * 片側しか無ければ、従来どおり等確率。
 */
function pickWeightedEvent<T extends { event: PlannedEvent }>(
  candidates: T[],
  outingPlaces: readonly string[],
  energy: number,
  random: () => number,
): T {
  const pickUniform = (items: T[]) =>
    items[Math.min(Math.floor(random() * items.length), items.length - 1)];
  const outings = candidates.filter((entry) => entry.event.placeKind === "outing");
  const stays = candidates.filter((entry) => entry.event.placeKind !== "outing");
  if (outings.length === 0 || stays.length === 0) return pickUniform(candidates);

  const weights = outings.map((entry) =>
    outingWeight(
      outingStyleOf(entry.event, outingPlaces),
      energy,
      entry.event.withCompanion,
    ),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const outingShare = total / outings.length;
  if (random() * (1 + outingShare) < 1) return pickUniform(stays);

  let r = random() * total;
  for (let i = 0; i < outings.length; i += 1) {
    r -= weights[i];
    if (r < 0) return outings[i];
  }
  return outings[outings.length - 1];
}

/**
 * その場所にいてよい時間か。
 *
 * - 平日の daytime（9〜17時）は学校の予定だけ。
 * - 学校の予定は平日の morning（朝練）・daytime・evening（部活・放課後）だけ。
 * - WakeUp と Sleep はどこでも可（SCHOOL_BOUND_STATUSES 参照）。
 */
export function isPlaceAllowed(
  event: Pick<PlannedEvent, "status" | "placeKind">,
  slot: TimeSlot,
  isDayOff: boolean,
): boolean {
  if (!SCHOOL_BOUND_STATUSES.has(event.status)) return true;
  const atSchool = event.placeKind === "school";
  if (!isDayOff && slot === "daytime") return atSchool;
  if (!atSchool) return true;
  return !isDayOff && (slot === "morning" || slot === "evening");
}

/**
 * step の描写プロンプトへ足す、今日の予定のブロック。
 *
 * buildPrompt は予定表を知らないので、これが無いと今日の筋書き
 * （服装・同行者・作品・場所）から外れた描写になり、記憶の中で1日が途切れる。
 */
export function buildPlannedEventSection(
  plan: DailyPlan | undefined,
  event: PlannedEvent | undefined,
): string {
  if (!plan || !event) return "";
  return `
-----今日の予定-----
* 今日1日ぶんの筋書きです。status_text はこの予定を描写に起こしてください。
  - 予定: ${event.activity}${event.place ? `\n  - 場所: ${event.place}（この場所にいる場面として描写すること）` : ""}
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
          timeSlots: {
            type: Type.ARRAY,
            items: { type: Type.STRING, enum: [...TIME_SLOTS] },
            description: "この行動をしてもおかしくない時間帯（複数可）",
          },
          place: { type: Type.STRING, description: "具体的な場所の名前" },
          placeKind: {
            type: Type.STRING,
            enum: [...PLACE_KINDS],
            description: "school=学校 / home=自宅 / outing=それ以外",
          },
          withCompanion: {
            type: Type.BOOLEAN,
            description: "今日の companion に含まれる相手が登場する行動なら true",
          },
        },
        required: [
          "status",
          "activity",
          "durationMinutes",
          "timeSlots",
          "place",
          "placeKind",
          "withCompanion",
        ],
      },
    },
  },
  required: ["outfit", "companion", "moodDirection", "events"],
};

export function buildDailyPlanPrompt(input: {
  botDate: string;
  isWeekend: boolean;
  companion: string;
  outingPlaces: string[];
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
  - "timeSlots" はその行動をしてもおかしくない時間帯。${TIME_SLOTS.map((slot) => `${slot}（${TIME_SLOT_LABELS[slot]}）`).join(" / ")} から当てはまるものをすべて選ぶこと。
  - "place" はその行動をする場所を具体的に（「駅前の水族館」「自室のベッドの上」「教室の窓際の席」など）。
  - "placeKind" は place の区分。school（学校：教室・図書室・校庭・部室など）/ home（自宅）/ outing（それ以外のおでかけ先）のいずれか。
  - "withCompanion" は、今日の companion に含まれる相手が登場する行動なら true、ひとりの行動なら false。

# 時間帯のルール
- どのステータスがいつ選ばれるかは決まっていない。botたんは夜更かしなので、FreeTime は夕方から深夜0時過ぎまで続くことがある。
- お店・カフェ・買い物・公園・外出・友達と会う行動は、その時間に実際にできる時間帯だけを選ぶこと（夜遅くや深夜のカフェ・買い物は不可）。
- FreeTime と Relax には、night と midnight を含む「自宅でひとりでもできる行動」をそれぞれ2件以上入れること。
- WakeUp は寝坊して昼に起きることもあるので、daytime を含む行動も1件以上入れること。
- Sleep は夢の中なので、原則すべての時間帯を選んでよい。

# 場所のルール
${input.isWeekend
  ? `- 今日は学校が休み。school の行動は作らないこと。`
  : `- 今日は平日なので、daytime（9〜17時）は学校にいる。Study・FreeTime・Relax にはそれぞれ、placeKind が school で daytime を含む行動を1件以上入れること。FreeTime と Relax の学校の行動は、休み時間・昼休みの過ごし方にすること。
- school の行動の timeSlots は daytime を中心に、朝練なら morning、部活や放課後の教室なら evening だけを足すこと。
- Study・FreeTime・Relax の home と outing の行動に daytime を付けないこと（平日の昼は学校にいるため）。寝坊の WakeUp と夢の中の Sleep はこの限りではない。`}
- 今日のおでかけ先は「${input.outingPlaces.join("」「")}」。それぞれを place にした outing の行動を1件以上作ること（${input.isWeekend ? "休日なので daytime が中心" : "平日なので放課後の evening が中心"}）。place は「遊園地」ではなく「隣町の遊園地」「駅ビルの水族館」のように、その場所を具体的に書くこと。
- ほかの outing（コンビニ・近所の公園など身近な場所）を足してもよい。
- botたんはインドア派。FreeTime には、おでかけ先の行動と同じ時間帯（${input.isWeekend ? "daytime" : "evening"}）に、${input.isWeekend ? "自宅（home）" : "自宅（home）か学校（school）"}で過ごす行動も1件以上入れること。出かけるかどうかは、その時の元気で決まる。
- 野球場は観戦、聖地巡礼は好きな作品の舞台になった場所めぐりとして描くこと。${input.companion === "ひとり" ? "" : `
- outing の行動には、companion と一緒のもの（withCompanion: true）と、ひとりで出かけるもの（withCompanion: false）の両方を入れること。`}

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
 * 場所のルールのうち、コードで確かめられる不足を文で返す（やり直しの指示にそのまま使う）。
 *
 * - 平日なのに、Study / FreeTime / Relax に「学校で daytime」の予定が無い。
 *   takePlannedEvent は平日の日中に学校以外を引かないので、無ければその時間は予定なしの
 *   描写に落ち、予定表の筋書き（服装・同行者）から外れる。
 * - コードで振ったおでかけ先が、どの予定の場所にも出てこない。
 */
export function findPlanPlaceShortfalls(
  events: readonly PlannedEvent[],
  isDayOff: boolean,
  outingPlaces: readonly string[],
  companion = "ひとり",
): string[] {
  const shortfalls: string[] = [];
  const has = (predicate: (event: PlannedEvent) => boolean) => events.some(predicate);
  if (!isDayOff) {
    for (const status of SCHOOL_BOUND_STATUSES) {
      const hasSchoolDaytime = events.some(
        (event) =>
          event.status === status &&
          event.placeKind === "school" &&
          event.timeSlots.includes("daytime"),
      );
      if (!hasSchoolDaytime) {
        shortfalls.push(`${status} に、placeKind が school で daytime を含む行動がありません`);
      }
    }
  }
  const places = events.map((event) => normalizeForMatch(`${event.place} ${event.activity}`));
  for (const outing of outingPlaces) {
    const needle = normalizeForMatch(outing);
    if (!places.some((text) => text.includes(needle))) {
      shortfalls.push(`今日のおでかけ先「${outing}」を place にした行動がありません`);
    }
  }
  for (const status of ["FreeTime", "Relax"] as const) {
    const nightHome = events.filter(
      (event) =>
        event.status === status &&
        event.placeKind === "home" &&
        (event.timeSlots.includes("night") || event.timeSlots.includes("midnight")),
    );
    if (nightHome.length < 2) {
      shortfalls.push(`${status} に、placeKind が home で night か midnight を含む行動が2件ありません`);
    }
  }
  // おでかけの時間帯に「出かけない」選択肢が無いと、元気が無くても必ず外出してしまう。
  const outingSlot: TimeSlot = isDayOff ? "daytime" : "evening";
  if (
    !has(
      (event) =>
        event.status === "FreeTime" &&
        event.placeKind !== "outing" &&
        event.timeSlots.includes(outingSlot) &&
        isPlaceAllowed(event, outingSlot, isDayOff),
    )
  ) {
    shortfalls.push(`FreeTime に、${outingSlot} を含む自宅${isDayOff ? "" : "か学校"}の行動がありません`);
  }
  if (companion !== "ひとり") {
    const outings = events.filter((event) => event.placeKind === "outing");
    if (!outings.some((event) => event.withCompanion)) {
      shortfalls.push("companion と一緒の outing の行動（withCompanion: true）がありません");
    }
    if (!outings.some((event) => !event.withCompanion)) {
      shortfalls.push("ひとりで出かける outing の行動（withCompanion: false）がありません");
    }
  }
  return shortfalls;
}

/**
 * 今日の予定表。bot 日が変わっていれば作り直す。
 *
 * 生成に失敗しても投げない。前日のプランがあれば日付だけ差し替えて再利用し、
 * それも無ければ undefined を返す。呼び出し側は予定なしの step 生成へ落ちる。
 */
export async function ensureDailyPlan(
  input: { eventSamples: Record<string, unknown> },
  now: Date = new Date(),
): Promise<DailyPlan | undefined> {
  const botDate = botDayRange(now).date;
  const existing = await loadPlan();
  if (isPlanFresh(existing, botDate)) return existing;
  const companion = selectDailyCompanion(botDate, existing);
  const outingPlaces = selectDailyOutingPlaces(existing);

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
    // 平日か休日かは step の時計ではなく bot 日から決める。予定表は bot 日の1日分なので。
    const isDayOff = isJapaneseDayOff(year, month, date);
    const basePrompt = buildDailyPlanPrompt({
      botDate,
      isWeekend: isDayOff,
      companion,
      outingPlaces,
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
      if (!parsed) return undefined;
      // 「ひとり」の日に同行者つきの予定が混ざると、おでかけの重みだけが上がってしまう。
      const events =
        companion === "ひとり"
          ? parsed.events.map((event) => ({ ...event, withCompanion: false }))
          : parsed.events;
      return { ...parsed, companion, outingPlaces, events };
    };

    let plan = await generate(basePrompt);
    if (!plan) throw new Error("Daily plan had no usable events");

    // 「お気に入りのアニソンを聴きながら」のような一般名詞のままの予定が残ると、描写側は
    // それを情景に起こすだけなので固有名詞にしようがない。場所のルール（平日の学校・今日の
    // おでかけ先）も同じで、ローカルモデルは指示だけでは守りきらない。生成後に検査し、
    // 1回だけまとめて直させる。1日1回の呼び出しなので追加コストは小さい。
    const memoryLabels = memoryImpressions.map((item) => item.label);
    const inspect = (candidate: DailyPlan) => ({
      generic: findGenericMediaEvents(candidate.events, works, memoryLabels),
      shortfalls: findPlanPlaceShortfalls(candidate.events, isDayOff, outingPlaces, companion),
    });
    const countIssues = (issues: ReturnType<typeof inspect>) =>
      issues.generic.length + issues.shortfalls.length;
    const first = inspect(plan);
    if (countIssues(first) > 0) {
      console.warn(
        `[WARN][BIORHYTHM] Daily plan had ${countIssues(first)} issue(s); retrying once: ` +
          [...first.generic.map((event) => event.activity), ...first.shortfalls].join(" / "),
      );
      const retried = await generate(
        `${basePrompt}

-----やり直しの指示-----
${first.generic.length > 0 ? `* 前回の予定表には、作品名の無い一般名詞だけの予定が残っていました:
${first.generic.map((event) => `  - ${event.activity}`).join("\n")}
* これらは「いま話題のもの」または「みんなとのやりとり」の候補から**具体的な名前を入れて書き直す**か、作品に触れない別の予定に差し替えてください。
` : ""}${first.shortfalls.length > 0 ? `* 前回の予定表は、場所のルールを満たしていませんでした:
${first.shortfalls.map((line) => `  - ${line}`).join("\n")}
* 足りない行動を、同じステータスのほかの予定と差し替えて入れてください。
` : ""}* ほかの予定はそのままでかまいません。予定表全体をもう一度出力してください。`,
      );
      const second = retried ? inspect(retried) : undefined;
      const adopted = Boolean(retried && second && countIssues(second) <= countIssues(first));
      if (adopted && retried) plan = retried;
      const remaining = adopted && second ? second : first;
      if (countIssues(remaining) > 0) {
        console.warn(
          `[WARN][BIORHYTHM] ${countIssues(remaining)} issue(s) remain after retry; keeping the plan`,
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
      `[INFO][BIORHYTHM] Daily plan for ${botDate}: ${plan.events.length} events, companion=${plan.companion}, outing=${plan.outingPlaces.join("/")}`,
    );
    return plan;
  } catch (error) {
    console.error("[ERROR][BIORHYTHM] Failed to build daily plan:", error);
    if (!existing) return undefined;
    // 前日のプランを today として引き継ぐ。同じ服・同じ相手で1日過ごすことになるが、
    // プラン無しで全 step を描写させるよりは一貫性が保てる。
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
