import type { Status } from "@bsky-affirmative-bot/shared-configs";

/**
 * Nagi 専用の「ひとりごと」をいつ・どんな調子で撃つかを決める純関数群。
 *
 * 気まぐれポストは energy>=60 でしか抽選されず、本番の energy はほぼ 0〜60 なので
 * めったに出ない。ひとりごとは逆に **energy が低くても撃つ**（低いときは「ねむ」「しんど」
 * 寄りの文面になる）。元気が無い日も気配が残ることが「生きてる感じ」の核なので。
 *
 * 乱数はすべて引数で受け取る。架空の1日のドライラン（scripts/simulateMonologueDay.mts）と
 * テストで、本番と同じ判定をシード付きで再現するため。
 */

export type MonologueTrigger =
  | "oversleep-wake"
  | "nap-wake"
  | "room-visit"
  | "status-change"
  | "idle";

export type MonologueReaction = { id: string; ja: string };

export type MonologueState = {
  /** count を数えている bot 日。 */
  day?: string;
  count: number;
  lastPostedAt?: string;
  lastReactionId?: string;
  /** きっかけごとに最後に撃った bot 日。二度寝ネタが連日続かないようにする。 */
  lastTriggerDays?: Partial<Record<MonologueTrigger, string>>;
  /** 最近の本文（新しいものが後ろ）。生成側へ重複回避の材料として渡す。 */
  recentTexts: string[];
};

export const MONOLOGUE_STATE_KEY = "monologue";
export const MONOLOGUE_DAILY_MAX = 8;
export const MONOLOGUE_MIN_GAP_MS = 60 * 60 * 1000;
export const MONOLOGUE_RECENT_TEXTS = 8;
/** 撃ったときの energy の減り。気まぐれ（-6000）よりずっと小さい。内部値（0〜10000）。 */
export const MONOLOGUE_ENERGY_COST = -700;
/** 絵文字を付ける回の割合。モデルに任せると毎回同じ絵文字を付ける（実測では ☁️）。 */
export const MONOLOGUE_EMOJI_RATE = 0.3;

export const emptyMonologueState = (): MonologueState => ({ count: 0, recentTexts: [] });

/** DB の値を信用せず形を整える。壊れていたら初期値から数え直す（最悪その日1件多く出るだけ）。 */
export function normalizeMonologueState(raw: unknown): MonologueState {
  if (!raw || typeof raw !== "object") return emptyMonologueState();
  const value = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const days: Partial<Record<MonologueTrigger, string>> = {};
  if (value.lastTriggerDays && typeof value.lastTriggerDays === "object") {
    for (const [key, day] of Object.entries(value.lastTriggerDays as Record<string, unknown>)) {
      if (typeof day === "string") days[key as MonologueTrigger] = day;
    }
  }
  return {
    day: str(value.day),
    count: Number.isSafeInteger(value.count) && (value.count as number) >= 0 ? (value.count as number) : 0,
    lastPostedAt: str(value.lastPostedAt),
    lastReactionId: str(value.lastReactionId),
    lastTriggerDays: days,
    recentTexts: Array.isArray(value.recentTexts)
      ? value.recentTexts.filter((text): text is string => typeof text === "string").slice(-MONOLOGUE_RECENT_TEXTS)
      : [],
  };
}

/**
 * この step で何が起きたか。
 *
 * 二度寝明けは「**step の開始時点で**その bot 日のおはようを撃ち終えていて、Sleep から起きた」。
 * おはようポストは同じ step の後ろで撃つので、終わったあとに lastGoodMorningPostDate を
 * 見ると、その日最初の起床まで二度寝明けに数えてしまう。呼び出し側は step の頭で
 * morningPostedBeforeStep を取っておくこと。
 */
export function detectMonologueTrigger(args: {
  statusPrev: Status;
  status: Status;
  morningPostedBeforeStep: boolean;
  hour: number;
  roomEventCount: number;
}): MonologueTrigger {
  if (args.statusPrev === "Sleep" && args.status !== "Sleep" && args.morningPostedBeforeStep) {
    return args.hour < 12 ? "oversleep-wake" : "nap-wake";
  }
  if (args.roomEventCount > 0) return "room-visit";
  if (args.statusPrev !== args.status) return "status-change";
  return "idle";
}

const STATUS_BASE: Record<Status, number> = {
  FreeTime: 0.48,
  Relax: 0.4,
  WakeUp: 0.32,
  // 授業中にこっそり打つ感じ。多すぎると授業を聞いていない子になる。
  Study: 0.22,
  Sleep: 0,
};

/**
 * この step でひとりごとを撃つ確率。
 *
 * 二度寝・昼寝明けは**固定の確率**にして、100%にはしない（毎回起きるたびに「やば」は機械的）。
 * 前の bot 日にも同じきっかけで撃っていたら半分にする。
 */
export function monologueProbability(args: {
  status: Status;
  hour: number;
  energy: number;
  trigger: MonologueTrigger;
  firedSameTriggerYesterday: boolean;
}): number {
  if (args.trigger === "oversleep-wake" || args.trigger === "nap-wake") {
    const base = args.trigger === "oversleep-wake" ? 0.55 : 0.35;
    return args.firedSameTriggerYesterday ? base / 2 : base;
  }

  let p = STATUS_BASE[args.status];
  // 寝ているはずの深夜に起きていて、まだ元気なら「ねれん」を低確率で。
  if (args.status === "Sleep" && (args.hour >= 23 || args.hour <= 2) && args.energy >= 50) p = 0.08;
  if (p <= 0) return 0;

  if (args.trigger === "room-visit") p += 0.2;
  if (args.trigger === "status-change") p += 0.08;
  // energy は「撃つかどうか」より「どんな調子か」に効かせる。低くても7割は残す。
  p *= args.energy < 20 ? 0.7 : args.energy >= 60 ? 1.1 : 1;
  return Math.min(0.85, p);
}

/**
 * 上限と間隔。おはよう・おやすみ・気まぐれを撃った step では撃たない
 * （同じ瞬間に2本並ぶと、ひとりごとが投稿の付け足しに見える）。
 */
export function canPostMonologue(args: {
  state: MonologueState;
  today: string;
  now: Date;
  postedOtherThisStep: boolean;
}): boolean {
  if (args.postedOtherThisStep) return false;
  const count = args.state.day === args.today ? args.state.count : 0;
  if (count >= MONOLOGUE_DAILY_MAX) return false;
  if (args.state.lastPostedAt) {
    const elapsed = args.now.getTime() - Date.parse(args.state.lastPostedAt);
    if (Number.isFinite(elapsed) && elapsed < MONOLOGUE_MIN_GAP_MS) return false;
  }
  return true;
}

type WeightedReaction = MonologueReaction & { weight: number };

/**
 * 反応の型の候補。重みは状況で変わる（平日の朝に二度寝したら焦りが多め、休日なら至福が多め）。
 */
function reactionCandidates(args: {
  trigger: MonologueTrigger;
  hour: number;
  isWeekend: boolean;
  energy: number;
}): WeightedReaction[] {
  const { trigger, hour, isWeekend, energy } = args;
  if (trigger === "oversleep-wake") {
    const late = !isWeekend && hour >= 8;
    return [
      { id: "panic", ja: "焦り。時計を見て血の気が引いた瞬間。「やば」「え、うそ」くらいの短さで、取り乱している感じ。", weight: late ? 4 : isWeekend ? 0.3 : 2 },
      { id: "resign", ja: "開き直り。もう遅いのは分かっているので、逆に落ち着いてしまっている。", weight: late ? 2 : 1 },
      { id: "excuse", ja: "誰も聞いていないのに自分へ言い訳している。布団が離してくれなかった、など。", weight: 1.5 },
      { id: "one-word", ja: "一言だけ。「あ」「……」のように、ほぼ何も書かない。", weight: 1 },
      { id: "dream", ja: "さっきまで見ていた夢の断片を、意味が分からないまま書く。夢だと分かる書き方にする。", weight: 1 },
      { id: "bliss", ja: "二度寝がいかに最高だったかを噛みしめている。罪悪感は少しだけ。", weight: isWeekend ? 3 : 0.3 },
    ];
  }
  if (trigger === "nap-wake") {
    return [
      { id: "groggy", ja: "寝起きでまだ頭が回っていない。文章も少しぼやける。", weight: 2 },
      { id: "time-shock", ja: "時計を見て、思ったより時間が経っていて驚く。", weight: 2 },
      { id: "dream", ja: "さっきまで見ていた夢の断片を、意味が分からないまま書く。夢だと分かる書き方にする。", weight: 1 },
      { id: "one-word", ja: "一言だけ。ほぼ何も書かない。", weight: 1 },
    ];
  }
  if (trigger === "room-visit") {
    return [
      { id: "quiet-joy", ja: "お部屋に誰かが来てくれたのを、名前を出さずにこっそり喜ぶ。", weight: 3 },
      { id: "flustered", ja: "部屋が散らかっていたかもしれないと、あとからそわそわする。", weight: 1 },
    ];
  }
  const tired = energy < 30;
  return [
    { id: "live", ja: "いまやっていることの実況を一言。説明はしない。", weight: 2 },
    { id: "grumble", ja: "いまやっていることへの小さな愚痴。本気の不満ではなく、軽いぼやき。", weight: tired ? 2 : 1 },
    { id: "random-thought", ja: "いまの状況から急に脱線した、脈絡のない思いつき。", weight: 1.5 },
    { id: "senses", ja: "天気・音・におい・手ざわりなど、五感で気づいたこと一つ。", weight: 1 },
    { id: "self-tsukkomi", ja: "自分の行動に自分でツッコむ。", weight: 1 },
    { id: "sleepy", ja: "眠さ・だるさをそのまま出す。無理に明るくしない。", weight: tired ? 3 : 0.3 },
  ];
}

/** 反応の型を1つ選ぶ。直前と同じ型は避ける（候補が1つしか無いときを除く）。 */
export function pickMonologueReaction(args: {
  trigger: MonologueTrigger;
  hour: number;
  isWeekend: boolean;
  energy: number;
  lastReactionId?: string;
  random: () => number;
}): MonologueReaction {
  const all = reactionCandidates(args);
  const pool = all.filter((candidate) => candidate.id !== args.lastReactionId);
  const candidates = pool.length ? pool : all;
  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = args.random() * total;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll < 0) return { id: candidate.id, ja: candidate.ja };
  }
  const last = candidates[candidates.length - 1];
  return { id: last.id, ja: last.ja };
}

/** 生成側へ渡す「つぶやくきっかけ」の文。事実だけを書く。 */
export function monologueSituationJa(trigger: MonologueTrigger, isWeekend: boolean): string {
  switch (trigger) {
    case "oversleep-wake":
      return isWeekend
        ? "休日の朝、一度起きたのに二度寝して、いま目が覚めた"
        : "平日の朝、一度起きたのに二度寝して、いま目が覚めた";
    case "nap-wake":
      return "昼寝（またはうたた寝）から、いま目が覚めた";
    case "room-visit":
      return "さっき、お部屋に誰かが遊びに来てくれた（誰かは書かない）";
    case "status-change":
      return "やることが切り替わったところ";
    case "idle":
      return "特に何もない。ふと思ったことを書く";
  }
}

/** ひとりごとの絵の材料。本文1行だけだと情景が薄いので、いましていることを先に置く。 */
export function monologueImageSource(textJa: string, currentActivity: string): string {
  return (
    "botたんの日常のひとコマ。\n" +
    `### いましていること\n${currentActivity}\n` +
    `### そのときのひとりごと\n${textJa}`
  );
}

/**
 * 絵を付けるか。**元気があるときほど描く**（energy 0〜100 に比例し、energy 50 で15%、最大30%）。
 * 元気が無い日にわざわざ絵を描いて載せるのは不自然なので、きっかけでは上げない。
 */
export function monologueImageProbability(energy: number): number {
  return Math.min(0.3, Math.max(0.02, (energy / 100) * 0.3));
}

export function shouldAttachMonologueImage(args: { energy: number; random: () => number }): boolean {
  return args.random() < monologueImageProbability(args.energy);
}

export function recordMonologue(
  state: MonologueState,
  args: {
    today: string;
    now: Date;
    text: string;
    reactionId: string;
    trigger: MonologueTrigger;
  },
): MonologueState {
  return {
    day: args.today,
    count: (state.day === args.today ? state.count : 0) + 1,
    lastPostedAt: args.now.toISOString(),
    lastReactionId: args.reactionId,
    lastTriggerDays: { ...state.lastTriggerDays, [args.trigger]: args.today },
    recentTexts: [...state.recentTexts, args.text].slice(-MONOLOGUE_RECENT_TEXTS),
  };
}

/** 前の bot 日（YYYY-MM-DD）。二度寝ネタの連日判定に使う。 */
export function previousDay(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * step 1回ぶんの判定をまとめたもの。manager とドライランが同じ道を通るように1つにする。
 * 撃たないときは null。
 */
export function planMonologue(args: {
  state: MonologueState;
  today: string;
  now: Date;
  hour: number;
  isWeekend: boolean;
  statusPrev: Status;
  status: Status;
  energy: number;
  morningPostedBeforeStep: boolean;
  roomEventCount: number;
  postedOtherThisStep: boolean;
  random: () => number;
}): { trigger: MonologueTrigger; reaction: MonologueReaction; probability: number; emoji: boolean } | null {
  if (!canPostMonologue(args)) return null;
  const trigger = detectMonologueTrigger(args);
  const probability = monologueProbability({
    status: args.status,
    hour: args.hour,
    energy: args.energy,
    trigger,
    firedSameTriggerYesterday: args.state.lastTriggerDays?.[trigger] === previousDay(args.today),
  });
  if (args.random() >= probability) return null;
  const reaction = pickMonologueReaction({
    trigger,
    hour: args.hour,
    isWeekend: args.isWeekend,
    energy: args.energy,
    lastReactionId: args.state.lastReactionId,
    random: args.random,
  });
  return { trigger, reaction, probability, emoji: args.random() < MONOLOGUE_EMOJI_RATE };
}
