import { generateContentWithRetry } from "@bsky-affirmative-bot/bot-brain";
import { MemoryService } from "@bsky-affirmative-bot/clients";
import {
  BOT_SCENE_BRIEF_JA,
  SYSTEM_INSTRUCTION,
  getFullDateAndTimeString,
  resolveAiRouteByName,
  type AiRouteName,
  type Status,
} from "@bsky-affirmative-bot/shared-configs";
import { Type } from "@google/genai";
import {
  DAILY_PLAN_STATE_KEY,
  buildPlannedEventSection,
  ensureDailyPlan,
  takePlannedEvent,
  type DailyPlan,
  type PlannedEvent,
} from "./dailyPlan.js";
import { buildRoomEventsSection, type RoomEventForPrompt } from "./roomEventPrompt.js";
import {
  WORK_KINDS,
  ensureSeasonalWorks,
  findGenericMediaEvents,
} from "./seasonalWorks.js";

/**
 * 状況描写のプレビュー。投稿もDB書き込み（履歴・biorhythm state）もしない。
 *
 * 見たいのは2つ。
 * 1. systemInstruction をペルソナ全文から描写用ブリーフへ絞ったときの、品質と入力トークンの差
 * 2. lite と flash の描写の差（予定表が骨組みを決めた今、lite で足りるか）
 *
 * 実行: pnpm --filter biorhythm-server status:preview
 *       pnpm --filter biorhythm-server status:preview --fresh   （今日の予定表を作り直す）
 * 注意: 日次予定表だけは bot_state を読み書きする（ensureDailyPlan）。
 */

const PREVIEW_STATUSES: Status[] = ["WakeUp", "Study", "FreeTime", "Relax", "Sleep"];

/** お部屋のできごとが混ざったときの挙動も見たいので、1件だけ用意する。 */
const SAMPLE_ROOM_EVENTS: RoomEventForPrompt[] = [
  { name: "すいばり", type: "gift", detail: "チョコレートケーキ", minutesAgo: 25 },
];

/** 比べる組み合わせ。ペルソナの大きさ × モデルの大きさ。 */
const VARIANTS: {
  label: string;
  route: AiRouteName;
  persona: string;
  personaLabel: string;
}[] = [
  { label: "lite + ブリーフ", route: "lite-flex", persona: BOT_SCENE_BRIEF_JA, personaLabel: "brief" },
  { label: "flash + ブリーフ", route: "flash-flex", persona: BOT_SCENE_BRIEF_JA, personaLabel: "brief" },
  { label: "flash + 全文（従来）", route: "flash-flex", persona: SYSTEM_INSTRUCTION, personaLabel: "full" },
];

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status_text: { type: Type.STRING },
    status_text_en: { type: Type.STRING },
    duration_minutes: { type: Type.INTEGER },
  },
  required: ["status_text", "status_text_en", "duration_minutes"],
};

async function generate(prompt: string, variant: (typeof VARIANTS)[number]) {
  // ルートを明示して requestOptions で上書きする。「明示 requestOptions > feature のルート」の
  // 優先順位に乗るので、BIORHYTHM_STATUS の既定値を変えずに複数ルートを撃ち比べられる
  // （packages/bot_brain/src/ai/util.ts の generateContentWithRetry を参照）。
  const route = resolveAiRouteByName(variant.route);
  let usage = "";
  const response = await generateContentWithRetry(
    {
      feature: "BIORHYTHM_STATUS",
      contents: prompt,
      config: {
        systemInstruction: variant.persona,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    },
    3,
    undefined,
    {
      model: route.model,
      ...(route.serviceTier ? { serviceTier: route.serviceTier } : {}),
      onUsage: (value) => {
        usage = `model=${value.model} in=${value.promptTokens} out=${value.outputTokens} think=${value.thinkingTokens} ms=${value.latencyMs}`;
      },
    },
  );
  const parsed = JSON.parse(response.text || "{}") as {
    status_text?: string;
    status_text_en?: string;
    duration_minutes?: number;
  };
  return { parsed, usage };
}

/** manager.buildPrompt の描写部分だけを、インスタンス状態に依存しない形で再現する。 */
function buildPreviewPrompt(input: {
  status: Status;
  event: PlannedEvent;
  plan: DailyPlan;
  roomEvents: RoomEventForPrompt[];
}): string {
  const outfitInstruction =
    input.status === "WakeUp"
      ? "今日の服装を自由に選んでください（ミント色のカーディガン以外のものも積極的に選ぶこと）。"
      : "服装は前回から変わっていないため、服装の描写は不要です。";
  return `
以下のキャラクター（System Instruction に設定されている「全肯定botたん」）の行動を描写してほしいです。
このキャラクターが現在どんな気分でなにをしているか、現在時刻・天候・ステータス・前回した行動・お部屋でのできごとをもとにして、具体的に考えてください。
* ルール
- 結果はJSON形式で出力してください。
- "status_text": 「全肯定たんは～しています」という、AIに入力する平易なプロンプト文（200文字以内）。服装について：${outfitInstruction}
- "status_text_en": status_text の英語訳（plain English, max 200 characters）。
- "duration_minutes": その行動にかかる時間（分）。5分から90分の範囲内で決めてください。
- 重要: status_textは必ず現在のステータス（${input.status}）に合った行動を描写すること。
- 重要: クラスメイトはことみちゃんだけ。ラテちゃんは学校・教室・授業・校庭には登場させず、放課後や休日など学校の外だけで交流させること。
- 重要: モルフォは学校へ連れて行かない。学校・教室・授業・校庭の場面には、モルフォを絶対に登場させないこと。
- 重要: 「お部屋でのできごと」に gift（プレゼント）がある場合は、必ずその贈り物への言及を status_text に入れること。
${buildRoomEventsSection(input.roomEvents)}

-----以下がキャラクターの状態-----
現在時刻：${getFullDateAndTimeString()}
天候：晴れ
ステータス：${input.status}
体力気力（0～100）：62
前回した行動：全肯定たんは、机に向かって課題のノートを開いています。
${buildPlannedEventSection(input.plan, input.event)}`;
}

async function previewStatus(plan: DailyPlan, status: Status, withRoomEvents: boolean) {
  const picked = takePlannedEvent(plan, status);
  console.log(`\n===== ${status}${withRoomEvents ? " (+ room gift)" : ""} =====`);
  if (!picked) {
    console.log("(予定表にこのステータスのイベントがありません)");
    return;
  }
  console.log(`予定: ${picked.event.activity}  /  ${picked.event.durationMinutes}分`);

  const prompt = buildPreviewPrompt({
    status,
    event: picked.event,
    plan,
    roomEvents: withRoomEvents ? SAMPLE_ROOM_EVENTS : [],
  });

  for (const variant of VARIANTS) {
    try {
      const { parsed, usage } = await generate(prompt, variant);
      console.log(`[${variant.label}] ${usage}`);
      console.log(`  ja: ${oneLine(parsed.status_text ?? "")}`);
      console.log(`  en: ${oneLine(parsed.status_text_en ?? "")}`);
    } catch (error) {
      console.log(`[${variant.label}] ERROR: ${(error as Error).message}`);
    }
  }
}

async function main() {
  // 予定表は bot_state に1日キャッシュされるので、プロンプトを直した直後に回すと
  // 古い予定表がそのまま出てくる。作り直したいときはこのフラグを付ける。
  if (process.argv.includes("--fresh") || process.env.PLAN_REFRESH === "1") {
    await MemoryService.setBotState(DAILY_PLAN_STATE_KEY, null);
    console.log("(--fresh: 今日の予定表を作り直します)");
  }

  const plan = await ensureDailyPlan({
    isWeekend: [0, 6].includes(new Date().getDay()),
    eventSamples: {},
  });
  if (!plan) {
    console.error("日次予定表を作れませんでした。GEMINI_API_KEY と DB 接続を確認してください。");
    process.exitCode = 1;
    return;
  }

  // 予定が一般名詞のままだったとき、そもそも候補が取れていないのかを切り分ける。
  const works = await ensureSeasonalWorks();
  console.log(`\n=== いま話題のもの（${works.length}件） ===`);
  for (const kind of WORK_KINDS) {
    const titles = works.filter((work) => work.kind === kind).map((work) => work.title);
    console.log(`  ${kind}: ${titles.length ? titles.join(" / ") : "(なし)"}`);
  }
  const generic = findGenericMediaEvents(plan.events, works);
  if (generic.length > 0) {
    console.log(`\n⚠ 固有名詞の無い予定が ${generic.length} 件残っています:`);
    for (const event of generic) console.log(`  - [${event.status}] ${event.activity}`);
  }

  console.log("\n=== 今日の予定表 ===");
  console.log(`服装: ${plan.outfit}`);
  console.log(`いっしょにいる人: ${plan.companion}`);
  console.log(`気分: ${plan.moodDirection}`);
  console.log(`イベント数: ${plan.events.length}`);
  for (const event of plan.events) {
    console.log(`  - [${event.status}] ${event.activity} (${event.durationMinutes}分)`);
  }
  console.log(
    `\n=== ペルソナの大きさ === brief=${BOT_SCENE_BRIEF_JA.length}字 / full=${SYSTEM_INSTRUCTION.length}字`,
  );

  for (const status of PREVIEW_STATUSES) {
    await previewStatus(plan, status, false);
  }
  // gift の言及必須ルールが効くかを1ケースだけ確認する。
  await previewStatus(plan, "FreeTime", true);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
