import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyPlanPrompt,
  buildPlannedEventSection,
  DAILY_COMPANION_OPTIONS,
  isPlanFresh,
  parseDailyPlan,
  selectDailyCompanion,
  takePlannedEvent,
  timeSlotForHour,
  TIME_SLOTS,
  type DailyPlan,
} from "../src/dailyPlan.js";

const plan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  botDate: "2026-08-10",
  outfit: "水色のワンピース",
  companion: "ことみちゃん",
  moodDirection: "のんびりしたい気分",
  events: [
    { status: "FreeTime", activity: "蒼穹のカノンの最新話を見る", durationMinutes: 45, timeSlots: [...TIME_SLOTS] },
    { status: "FreeTime", activity: "モルフォと散歩する", durationMinutes: 30, timeSlots: [...TIME_SLOTS] },
    { status: "Study", activity: "数学の課題をやる", durationMinutes: 60, timeSlots: [...TIME_SLOTS] },
  ],
  usedEventIds: [],
  ...overrides,
});

test("ステータスに合うイベントだけを返す", () => {
  const picked = takePlannedEvent(plan(), "Study", 20);
  assert.equal(picked?.event.activity, "数学の課題をやる");
  assert.equal(picked?.index, 2);
});

test("そのステータスのイベントが無ければ undefined（Geminiフォールバックに落ちる）", () => {
  assert.equal(takePlannedEvent(plan(), "Sleep", 20), undefined);
  assert.equal(takePlannedEvent(undefined, "Study", 20), undefined);
});

test("未消化を優先して選ぶ", () => {
  const picked = takePlannedEvent(plan({ usedEventIds: [0] }), "FreeTime", 20);
  assert.equal(picked?.index, 1);
});

test("未消化が尽きたら消化済みを再利用する", () => {
  const picked = takePlannedEvent(plan({ usedEventIds: [0, 1, 2] }), "FreeTime", 20);
  assert.ok(picked);
  assert.ok([0, 1].includes(picked.index));
});

test("直前に選んだ予定は選ばない", () => {
  // 描写文は予定文そのままではないので、直前判定は文字列ではなくインデックスで行う。
  const picked = takePlannedEvent(
    plan({ usedEventIds: [0, 1], lastEventIndex: 0 }),
    "FreeTime",
  );
  assert.equal(picked?.index, 1);
});

test("候補が1件しか無ければ直前と同じでもそれを返す", () => {
  const picked = takePlannedEvent(
    plan({
      events: [
        { status: "Study", activity: "数学の課題をやる", durationMinutes: 60, timeSlots: [...TIME_SLOTS] },
      ],
      usedEventIds: [0],
      lastEventIndex: 0,
    }),
    "Study",
    20,
  );
  assert.equal(picked?.event.activity, "数学の課題をやる");
});

test("時(JST)を時間帯へ振り分ける", () => {
  assert.deepEqual(
    [3, 4, 8, 9, 16, 17, 20, 21, 23, 0].map(timeSlotForHour),
    ["midnight", "morning", "morning", "daytime", "daytime", "evening", "evening", "night", "night", "midnight"],
  );
});

test("今の時間帯に合わない予定は、使い回しのときも選ばない", () => {
  // 2026-09-28: FreeTime の5件を夕方までに使い切り、23時に「カフェで新作スイーツ」を再利用した。
  const nightPlan = plan({
    events: [
      { status: "FreeTime", activity: "ことみちゃんとカフェで新作スイーツを食べる", durationMinutes: 60, timeSlots: ["daytime", "evening"] },
      { status: "FreeTime", activity: "自室で蒼穹のカノンの最新話を見る", durationMinutes: 45, timeSlots: ["evening", "night", "midnight"] },
    ],
    usedEventIds: [0, 1],
    lastEventIndex: 1,
  });

  for (let i = 0; i < 20; i += 1) {
    assert.equal(takePlannedEvent(nightPlan, "FreeTime", 23)?.index, 1);
  }
  assert.equal(takePlannedEvent(nightPlan, "FreeTime", 15)?.index, 0);
});

test("今の時間帯に合う予定が無ければ undefined（予定なしの描写へ落ちる）", () => {
  const dayOnly = plan({
    events: [
      { status: "FreeTime", activity: "ことみちゃんと雑貨屋を巡る", durationMinutes: 90, timeSlots: ["daytime"] },
    ],
  });
  assert.equal(takePlannedEvent(dayOnly, "FreeTime", 23), undefined);
});

test("timeSlots が欠けた・不正な予定はいつでも可として読む", () => {
  const parsed = parseDailyPlan(
    {
      events: [
        { status: "Relax", activity: "お茶を飲む", durationMinutes: 10 },
        { status: "Relax", activity: "日記を書く", durationMinutes: 10, timeSlots: ["late", "night", "night"] },
      ],
    },
    "2026-08-10",
  );
  assert.deepEqual(parsed?.events.map((event) => event.timeSlots), [
    [...TIME_SLOTS],
    ["night"],
  ]);
});

test("予定生成で時間帯と、夜の自宅向けの予定を指示する", () => {
  const prompt = buildDailyPlanPrompt({
    botDate: "2026-08-20",
    isWeekend: false,
    companion: "ことみちゃん",
    whatDay: [],
    eventSamples: {},
    worksSection: "",
  });
  assert.match(prompt, /"timeSlots"/);
  assert.match(prompt, /night（21〜24時）/);
  assert.match(prompt, /夜遅くや深夜のカフェ・買い物は不可/);
  assert.match(prompt, /FreeTime と Relax には、night と midnight を含む/);
});

test("bot日が変わったプランは失効する", () => {
  assert.equal(isPlanFresh(plan(), "2026-08-10"), true);
  assert.equal(isPlanFresh(plan(), "2026-08-11"), false);
  assert.equal(isPlanFresh(plan({ events: [] }), "2026-08-10"), false);
  assert.equal(isPlanFresh(undefined, "2026-08-10"), false);
});

test("durationMinutes は 5〜90 にクランプする", () => {
  const parsed = parseDailyPlan(
    {
      outfit: "水色のワンピース",
      companion: "ひとり",
      moodDirection: "元気",
      events: [
        { status: "Study", activity: "課題", durationMinutes: 300 },
        { status: "Relax", activity: "お茶を飲む", durationMinutes: 1 },
        { status: "Sleep", activity: "夢を見る", durationMinutes: "abc" },
      ],
    },
    "2026-08-10",
  );

  assert.deepEqual(
    parsed?.events.map((event) => event.durationMinutes),
    [90, 5, 30],
  );
});

test("未知のステータスや空の activity を持つイベントは捨てる", () => {
  const parsed = parseDailyPlan(
    {
      outfit: "",
      companion: "",
      moodDirection: "",
      events: [
        { status: "Shopping", activity: "買い物", durationMinutes: 30 },
        { status: "Study", activity: "   ", durationMinutes: 30 },
        { status: "Study", activity: "課題", durationMinutes: 30 },
      ],
    },
    "2026-08-10",
  );

  assert.equal(parsed?.events.length, 1);
  assert.equal(parsed?.events[0]?.activity, "課題");
});

test("使えるイベントが1件も無ければ undefined を返す", () => {
  assert.equal(parseDailyPlan({ events: [] }, "2026-08-10"), undefined);
  assert.equal(parseDailyPlan(null, "2026-08-10"), undefined);
  assert.equal(parseDailyPlan("{}", "2026-08-10"), undefined);
});

test("Gemini フォールバックにも今日の予定を渡す", () => {
  const section = buildPlannedEventSection(plan(), {
    status: "FreeTime",
    activity: "パトレイバーの日だから、ロボットアニメについて語り合うよ",
    durationMinutes: 60,
    timeSlots: [...TIME_SLOTS],
  });

  assert.match(section, /予定: パトレイバーの日だから/);
  assert.match(section, /今日の主な同行者: ことみちゃん/);
  // 作品名が一般名詞に落ちるのはローカル・Gemini 双方で起きたので、両方に同じ拘束を置く。
  assert.match(section, /一般名詞に言い換えず、そのまま status_text に書くこと/);
});

test("予定表が無ければフォールバック側には何も足さない", () => {
  assert.equal(buildPlannedEventSection(undefined, undefined), "");
  assert.equal(buildPlannedEventSection(plan(), undefined), "");
});

test("ひとり・各1人・各2人組・3人全員を選択対象にする", () => {
  const selected = DAILY_COMPANION_OPTIONS.map((_, index) =>
    selectDailyCompanion(
      "2026-08-20",
      undefined,
      () => (index + 0.5) / DAILY_COMPANION_OPTIONS.length,
    ),
  );

  assert.deepEqual(selected, [...DAILY_COMPANION_OPTIONS]);
});

test("前日と完全に同じ同行者は選ばず、一部が重なる組み合わせは許す", () => {
  const previousPlan = {
    botDate: "2026-08-19",
    companion: "ラテちゃん",
  };
  const possible = Array.from({ length: 7 }, (_, index) =>
    selectDailyCompanion(
      "2026-08-20",
      previousPlan,
      () => (index + 0.5) / 7,
    ),
  );

  assert.equal(possible.includes("ラテちゃん"), false);
  assert.equal(possible.includes("ことみちゃん・ラテちゃん"), true);
  assert.equal(possible.includes("ラテちゃん・モルフォ"), true);
  assert.equal(possible.length, 7);
});

test("保存済みプランが前日以外なら同行者の除外には使わない", () => {
  assert.equal(
    selectDailyCompanion(
      "2026-08-20",
      { botDate: "2026-08-18", companion: "ひとり" },
      () => 0,
    ),
    "ひとり",
  );
});

test("予定生成と描写の両方で、同行者の固定と学校のモルフォ禁止を指示する", () => {
  const prompt = buildDailyPlanPrompt({
    botDate: "2026-08-20",
    isWeekend: false,
    companion: "ラテちゃん",
    whatDay: [],
    eventSamples: {},
    worksSection: "",
  });
  const section = buildPlannedEventSection(
    plan({ companion: "モルフォ" }),
    { status: "Study", activity: "教室で数学を勉強する", durationMinutes: 60, timeSlots: ["daytime"] },
  );

  assert.match(prompt, /必ず「ラテちゃん」と出力/);
  assert.match(prompt, /同行者の組み合わせ/);
  assert.match(prompt, /全員が一緒に過ごす行動を少なくとも1件/);
  assert.match(prompt, /companion に含まれない相手を行動へ登場させない/);
  assert.match(prompt, /クラスメイトはことみちゃんだけ/);
  assert.match(prompt, /ラテちゃん.*学校・教室・授業・校庭.*登場させず/);
  assert.match(prompt, /学校・教室・授業・校庭.*絶対にモルフォを登場させない/);
  assert.match(section, /予定に名前がない場面へ無理に登場させない/);
  assert.match(section, /ラテちゃんはクラスメイトではありません/);
  assert.match(section, /学校・教室・授業・校庭.*絶対に登場させない/);
});

test("会話由来のテーマを検索由来作品とは別セクションで予定へ渡す", () => {
  const prompt = buildDailyPlanPrompt({
    botDate: "2026-08-22",
    isWeekend: true,
    companion: "ひとり",
    whatDay: [],
    eventSamples: {},
    worksSection: "\n-----いま話題のもの-----\n作品A",
    memoryImpressionsSection: "\n-----みんなとのやりとりで印象に残ったもの-----\n作品B",
  });
  assert.match(prompt, /いま話題のもの/);
  assert.match(prompt, /みんなとのやりとりで印象に残ったもの/);
  assert.match(prompt, /作品B/);
});

test("日次予定プロンプトはbotDateから曜日を確定する", () => {
  const prompt = buildDailyPlanPrompt({
    botDate: "2026-08-29",
    isWeekend: true,
    companion: "ひとり",
    whatDay: ["焼き肉の日"],
    eventSamples: {},
    worksSection: "",
  });

  assert.match(prompt, /2026-08-29（土曜日・休日）/);
  assert.doesNotMatch(prompt, /金曜日/);
});
