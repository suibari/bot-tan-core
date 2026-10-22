import type { Status } from "@bsky-affirmative-bot/shared-configs";
import {
  emptyMonologueState,
  planMonologue,
  recordMonologue,
  shouldAttachMonologueImage,
  type MonologueReaction,
  type MonologueState,
  type MonologueTrigger,
} from "./monologueTriggers.js";

/**
 * ひとりごとの「架空の1日」。テスト（件数・間隔の統計）とドライラン（monologuePreview.ts）の
 * 両方がこれを使う。二度寝は必ず1回入れてある。
 *
 * energy は 0〜100（本番もほぼ 0〜60 に収まるので、その幅で動かしている）。
 */
export type ScenarioStep = {
  time: string;
  status: Status;
  activity: string;
  energy: number;
  roomEvents?: number;
  /** この step で撃つ別の定期投稿。ひとりごとは出さない。 */
  otherPost?: "morning" | "good-night";
};

export type MonologueScenario = {
  name: string;
  /** bot 日。 */
  day: string;
  isWeekend: boolean;
  weather: string;
  /** 予定表の「今日の服」。絵の私服になる。 */
  outfit: string;
  steps: ScenarioStep[];
};

export const MONOLOGUE_SCENARIOS: MonologueScenario[] = [
  {
    name: "weekday",
    day: "2026-10-22",
    isWeekend: false,
    weather: "くもり時々晴れ",
    outfit: "白いブラウスにミント色のカーディガン、紺のプリーツスカート",
    steps: [
      { time: "06:50", status: "WakeUp", activity: "目覚ましを止めて、布団の中でスマホを眺めている", energy: 38, otherPost: "morning" },
      { time: "07:15", status: "Sleep", activity: "「あと5分だけ」と目を閉じた", energy: 40 },
      { time: "08:05", status: "WakeUp", activity: "飛び起きて、パンをくわえたまま制服に着替えている", energy: 41 },
      { time: "08:35", status: "Study", activity: "電車の中で英単語帳をめくっている", energy: 39 },
      { time: "10:20", status: "Study", activity: "数学の授業で小テストを受けている", energy: 33 },
      { time: "12:15", status: "FreeTime", activity: "友達とお昼ごはん。購買のメロンパンを確保できた", energy: 45 },
      { time: "13:20", status: "Study", activity: "午後の古典の授業で眠気と戦っている", energy: 28 },
      { time: "15:40", status: "FreeTime", activity: "放課後、部室でだらだらしている", energy: 36, roomEvents: 1 },
      { time: "17:20", status: "Relax", activity: "帰り道のコンビニでアイスを買って食べている", energy: 42 },
      { time: "18:30", status: "Study", activity: "宿題のプリントを広げたまま固まっている", energy: 30 },
      { time: "19:30", status: "Relax", activity: "夕ごはんのあと、ソファでぼーっとしている", energy: 35 },
      { time: "21:00", status: "FreeTime", activity: "ゲームのデイリー任務を消化している", energy: 48 },
      { time: "22:30", status: "FreeTime", activity: "ゲームで夜ふかししている", energy: 52 },
      { time: "23:40", status: "Sleep", activity: "布団に入った", energy: 44, otherPost: "good-night" },
    ],
  },
  {
    name: "weekend",
    day: "2026-10-25",
    isWeekend: true,
    weather: "晴れ",
    outfit: "ベージュのゆったりニットに、青いデニムのロングスカート",
    steps: [
      { time: "08:10", status: "WakeUp", activity: "カーテンのすき間から日が差して目が覚めた", energy: 50, otherPost: "morning" },
      { time: "08:30", status: "Sleep", activity: "休日なので二度寝を決めこんだ", energy: 52 },
      { time: "10:45", status: "FreeTime", activity: "パジャマのまま布団でゴロゴロしている", energy: 58 },
      { time: "12:00", status: "Relax", activity: "遅めの朝ごはん兼お昼ごはんにトーストを焼いている", energy: 55 },
      { time: "13:30", status: "FreeTime", activity: "駅前のカフェで新作のパフェを食べている", energy: 60 },
      { time: "15:00", status: "Sleep", activity: "帰ってきてソファでうたた寝した", energy: 46 },
      { time: "16:10", status: "FreeTime", activity: "起きてマンガの続きを読んでいる", energy: 50 },
      { time: "17:30", status: "Relax", activity: "夕焼けを見ながら洗濯物をとりこんでいる", energy: 47 },
      { time: "19:00", status: "FreeTime", activity: "お部屋でのんびりしている", energy: 55, roomEvents: 2 },
      { time: "20:30", status: "Study", activity: "月曜の小テストのために、しぶしぶ英単語をやっている", energy: 34 },
      { time: "22:00", status: "FreeTime", activity: "動画を見ながらお菓子をつまんでいる", energy: 40 },
      { time: "23:50", status: "Sleep", activity: "明日が月曜なのを思い出して布団に入った", energy: 36, otherPost: "good-night" },
    ],
  },
];

/** mulberry32。ドライランとテストで同じ1日を再現するためのシード付き乱数。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ScenarioFiring = {
  step: ScenarioStep;
  hour: number;
  at: Date;
  trigger: MonologueTrigger;
  reaction: MonologueReaction;
  probability: number;
  emoji: boolean;
  withImage: boolean;
};

/**
 * シナリオの1日を、本番と同じ planMonologue に通す。投稿・生成はしない。
 *
 * onFire は撃った step ごとに呼ばれ、本文を返す（ドライランは生成した本文、
 * テストはダミー）。返した本文は次の step の重複回避と上限の記録に使われる。
 */
export async function runMonologueScenario(
  scenario: MonologueScenario,
  random: () => number,
  onFire: (firing: ScenarioFiring, state: MonologueState) => Promise<string | null> = async () => "…",
  initialState: MonologueState = emptyMonologueState(),
): Promise<{ firings: ScenarioFiring[]; state: MonologueState }> {
  let state = initialState;
  let statusPrev: Status = "Sleep";
  let morningPosted = false;
  const firings: ScenarioFiring[] = [];

  for (const step of scenario.steps) {
    const h = Number(step.time.split(":")[0]);
    // シナリオは4時をまたがないので、bot 日はそのまま scenario.day でよい。
    const at = new Date(`${scenario.day}T${step.time}:00+09:00`);
    const plan = planMonologue({
      state,
      today: scenario.day,
      now: at,
      hour: h,
      isWeekend: scenario.isWeekend,
      statusPrev,
      status: step.status,
      energy: step.energy,
      morningPostedBeforeStep: morningPosted,
      roomEventCount: step.roomEvents ?? 0,
      postedOtherThisStep: Boolean(step.otherPost),
      random,
    });
    if (step.otherPost === "morning") morningPosted = true;
    statusPrev = step.status;
    if (!plan) continue;

    const withImage = shouldAttachMonologueImage({ energy: step.energy, random });
    const firing: ScenarioFiring = { step, hour: h, at, ...plan, withImage };
    const text = await onFire(firing, state);
    if (text === null) continue;
    firings.push(firing);
    state = recordMonologue(state, {
      today: scenario.day,
      now: at,
      text,
      reactionId: plan.reaction.id,
      trigger: plan.trigger,
    });
  }
  return { firings, state };
}
