import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyPlanPrompt,
  buildPlannedEventSection,
  DAILY_COMPANION_OPTIONS,
  DAILY_OUTING_PLACE_STYLES,
  DAILY_OUTING_PLACES,
  findPlanPlaceShortfalls,
  isPlaceAllowed,
  isPlanFresh,
  OUTING_STYLES,
  outingStyleOf,
  outingWeight,
  parseDailyPlan,
  selectDailyCompanion,
  selectDailyOutingPlaces,
  takePlannedEvent,
  timeSlotForHour,
  TIME_SLOTS,
  type DailyPlan,
  type PlannedEvent,
} from "../src/dailyPlan.js";

const plan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  botDate: "2026-08-10",
  outfit: "水色のワンピース",
  companion: "ことみちゃん",
  outingPlaces: ["水族館"],
  moodDirection: "のんびりしたい気分",
  events: [
    { status: "FreeTime", activity: "蒼穹のカノンの最新話を見る", durationMinutes: 45, timeSlots: [...TIME_SLOTS], place: "自室", placeKind: "home", withCompanion: false },
    { status: "FreeTime", activity: "モルフォと散歩する", durationMinutes: 30, timeSlots: [...TIME_SLOTS], place: "自室", placeKind: "home", withCompanion: false },
    { status: "Study", activity: "数学の課題をやる", durationMinutes: 60, timeSlots: [...TIME_SLOTS], place: "自室", placeKind: "home", withCompanion: false },
  ],
  usedEventIds: [],
  ...overrides,
});

test("ステータスに合うイベントだけを返す", () => {
  const picked = takePlannedEvent(plan(), "Study", 20, true, 35);
  assert.equal(picked?.event.activity, "数学の課題をやる");
  assert.equal(picked?.index, 2);
});

test("そのステータスのイベントが無ければ undefined（Geminiフォールバックに落ちる）", () => {
  assert.equal(takePlannedEvent(plan(), "Sleep", 20, true, 35), undefined);
  assert.equal(takePlannedEvent(undefined, "Study", 20, true, 35), undefined);
});

test("未消化を優先して選ぶ", () => {
  const picked = takePlannedEvent(plan({ usedEventIds: [0] }), "FreeTime", 20, true, 35);
  assert.equal(picked?.index, 1);
});

test("未消化が尽きたら消化済みを再利用する", () => {
  const picked = takePlannedEvent(plan({ usedEventIds: [0, 1, 2] }), "FreeTime", 20, true, 35);
  assert.ok(picked);
  assert.ok([0, 1].includes(picked.index));
});

test("直前に選んだ予定は選ばない", () => {
  // 描写文は予定文そのままではないので、直前判定は文字列ではなくインデックスで行う。
  const picked = takePlannedEvent(
    plan({ usedEventIds: [0, 1], lastEventIndex: 0 }),
    "FreeTime",
    20,
    true,
    35,
  );
  assert.equal(picked?.index, 1);
});

test("候補が1件しか無ければ直前と同じでもそれを返す", () => {
  const picked = takePlannedEvent(
    plan({
      events: [
        { status: "Study", activity: "数学の課題をやる", durationMinutes: 60, timeSlots: [...TIME_SLOTS], place: "自室", placeKind: "home", withCompanion: false },
      ],
      usedEventIds: [0],
      lastEventIndex: 0,
    }),
    "Study",
    20,
    true,
    35,
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
      { status: "FreeTime", activity: "ことみちゃんとカフェで新作スイーツを食べる", durationMinutes: 60, timeSlots: ["daytime", "evening"], place: "自室", placeKind: "home", withCompanion: false },
      { status: "FreeTime", activity: "自室で蒼穹のカノンの最新話を見る", durationMinutes: 45, timeSlots: ["evening", "night", "midnight"], place: "自室", placeKind: "home", withCompanion: false },
    ],
    usedEventIds: [0, 1],
    lastEventIndex: 1,
  });

  for (let i = 0; i < 20; i += 1) {
    assert.equal(takePlannedEvent(nightPlan, "FreeTime", 23, true, 35)?.index, 1);
  }
  assert.equal(takePlannedEvent(nightPlan, "FreeTime", 15, true, 35)?.index, 0);
});

test("今の時間帯に合う予定が無ければ undefined（予定なしの描写へ落ちる）", () => {
  const dayOnly = plan({
    events: [
      { status: "FreeTime", activity: "ことみちゃんと雑貨屋を巡る", durationMinutes: 90, timeSlots: ["daytime"], place: "自室", placeKind: "home", withCompanion: false },
    ],
  });
  assert.equal(takePlannedEvent(dayOnly, "FreeTime", 23, true, 35), undefined);
});

test("timeSlots が欠けた・不正な予定はいつでも可として読む", () => {
  const parsed = parseDailyPlan(
    {
      events: [
        { status: "Relax", activity: "お茶を飲む", durationMinutes: 10 },
        { status: "Relax", activity: "日記を書く", durationMinutes: 10, timeSlots: ["late", "night", "night"], place: "自室", placeKind: "home", withCompanion: false },
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
    outingPlaces: ["水族館", "古本屋"],
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
    outingPlaces: ["水族館", "古本屋"],
    whatDay: [],
    eventSamples: {},
    worksSection: "",
  });
  const section = buildPlannedEventSection(
    plan({ companion: "モルフォ" }),
    { status: "Study", activity: "教室で数学を勉強する", durationMinutes: 60, timeSlots: ["daytime"], place: "自室", placeKind: "home", withCompanion: false },
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
    outingPlaces: ["水族館", "古本屋"],
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
    outingPlaces: ["水族館", "古本屋"],
    whatDay: ["焼き肉の日"],
    eventSamples: {},
    worksSection: "",
  });

  assert.match(prompt, /2026-08-29（土曜日・休日）/);
  assert.doesNotMatch(prompt, /金曜日/);
});

// --- 場所 ---

const event = (overrides: Partial<PlannedEvent>): PlannedEvent => ({
  status: "FreeTime",
  activity: "予定",
  durationMinutes: 30,
  timeSlots: [...TIME_SLOTS],
  place: "",
  placeKind: "home",
  withCompanion: false,
  ...overrides,
});

test("平日の日中は学校の予定だけを引く", () => {
  // 以前は平日の昼に FreeTime が選ばれると、自宅でゲームをする描写になっていた。
  const weekdayPlan = plan({
    events: [
      event({ activity: "自室でゲームする", placeKind: "home" }),
      event({ activity: "昼休みに屋上でことみちゃんとおしゃべり", placeKind: "school" }),
      event({ activity: "駅前の水族館に行く", placeKind: "outing" }),
    ],
  });
  for (let i = 0; i < 20; i += 1) {
    assert.equal(takePlannedEvent(weekdayPlan, "FreeTime", 12, false, 35)?.index, 1);
  }
});

test("平日の日中に学校の予定が無ければ undefined（予定なしの描写へ落ちる）", () => {
  const homeOnly = plan({ events: [event({ placeKind: "home" }), event({ placeKind: "outing" })] });
  assert.equal(takePlannedEvent(homeOnly, "FreeTime", 12, false, 35), undefined);
  assert.equal(takePlannedEvent(homeOnly, "Relax", 12, false, 35), undefined);
});

test("学校の予定は休日と夜には引かない", () => {
  const school = event({ placeKind: "school" });
  assert.equal(isPlaceAllowed(school, "daytime", true), false);
  assert.equal(isPlaceAllowed(school, "night", false), false);
  assert.equal(isPlaceAllowed(school, "midnight", false), false);
  // 朝練・部活は平日だけ。
  assert.equal(isPlaceAllowed(school, "morning", false), true);
  assert.equal(isPlaceAllowed(school, "evening", false), true);
  assert.equal(isPlaceAllowed(school, "evening", true), false);
});

test("休日と平日の放課後は自宅・おでかけ先を引ける", () => {
  assert.equal(isPlaceAllowed(event({ placeKind: "outing" }), "daytime", true), true);
  assert.equal(isPlaceAllowed(event({ placeKind: "home" }), "evening", false), true);
  assert.equal(isPlaceAllowed(event({ placeKind: "home" }), "daytime", false), false);
});

test("WakeUp と Sleep は平日の日中でも場所を問わない", () => {
  // 寝坊して昼に起きる・夢の中、はどこでも成立する。
  assert.equal(isPlaceAllowed(event({ status: "WakeUp", placeKind: "home" }), "daytime", false), true);
  assert.equal(isPlaceAllowed(event({ status: "Sleep", placeKind: "outing" }), "daytime", false), true);
});

test("placeKind が不正なら outing として読み、place が無ければ空文字", () => {
  const parsed = parseDailyPlan(
    {
      events: [
        { status: "Relax", activity: "お茶を飲む", durationMinutes: 10, place: " 縁側 ", placeKind: "garden" },
        { status: "Relax", activity: "日記を書く", durationMinutes: 10 },
      ],
    },
    "2026-08-10",
  );
  assert.deepEqual(
    parsed?.events.map((item) => [item.place, item.placeKind]),
    [["縁側", "outing"], ["", "outing"]],
  );
});

test("おでかけ先は候補から重複なく振り、前回の行き先は外す", () => {
  const first = selectDailyOutingPlaces(undefined, () => 0);
  assert.deepEqual(first, [DAILY_OUTING_PLACES[0], DAILY_OUTING_PLACES[1]]);

  const next = selectDailyOutingPlaces({ outingPlaces: first }, () => 0);
  assert.equal(next.length, 2);
  assert.equal(next.some((place) => first.includes(place)), false);
  assert.equal(new Set(next).size, 2);

  // random() が 1 に張り付いても範囲外を引かない。
  assert.equal(selectDailyOutingPlaces(undefined, () => 0.9999999).length, 2);
});

const nightHome = [
  event({ status: "FreeTime", placeKind: "home", timeSlots: ["night"] }),
  event({ status: "FreeTime", placeKind: "home", timeSlots: ["midnight"] }),
  event({ status: "Relax", placeKind: "home", timeSlots: ["night"] }),
  event({ status: "Relax", placeKind: "home", timeSlots: ["night", "midnight"] }),
];

test("平日の学校の予定とおでかけ先の不足を指摘する", () => {
  const events = [
    ...nightHome,
    event({ status: "Study", placeKind: "school", timeSlots: ["daytime"] }),
    event({ status: "FreeTime", placeKind: "school", timeSlots: ["evening"] }),
    event({ status: "Relax", placeKind: "home", timeSlots: ["daytime"] }),
    event({ status: "FreeTime", placeKind: "outing", place: "駅ビルの水族館", timeSlots: ["evening"] }),
  ];
  assert.deepEqual(findPlanPlaceShortfalls(events, false, ["水族館", "古本屋"]), [
    "FreeTime に、placeKind が school で daytime を含む行動がありません",
    "Relax に、placeKind が school で daytime を含む行動がありません",
    "今日のおでかけ先「古本屋」を place にした行動がありません",
  ]);
  // 休日は学校の予定を求めない。代わりに、日中に自宅で過ごす FreeTime が要る。
  assert.deepEqual(findPlanPlaceShortfalls(events, true, ["水族館"]), [
    "FreeTime に、daytime を含む自宅の行動がありません",
  ]);
  assert.deepEqual(
    findPlanPlaceShortfalls(
      [...events, event({ status: "FreeTime", placeKind: "home", timeSlots: ["daytime"] })],
      true,
      ["水族館"],
    ),
    [],
  );
});

test("夜の自宅の予定と、おでかけしない選択肢の不足を指摘する", () => {
  const events = [
    event({ status: "FreeTime", placeKind: "home", timeSlots: ["night"] }),
    event({ status: "FreeTime", placeKind: "outing", place: "水族館", timeSlots: ["daytime"] }),
    ...nightHome.slice(2),
  ];
  assert.deepEqual(findPlanPlaceShortfalls(events, true, ["水族館"]), [
    "FreeTime に、placeKind が home で night か midnight を含む行動が2件ありません",
    "FreeTime に、daytime を含む自宅の行動がありません",
  ]);
});

test("同行者がいる日は、同行者ありとひとりのおでかけを両方求める", () => {
  const base = [...nightHome, event({ status: "FreeTime", placeKind: "home", timeSlots: ["daytime"] })];
  const together = event({ status: "FreeTime", placeKind: "outing", place: "水族館", withCompanion: true });
  const alone = event({ status: "FreeTime", placeKind: "outing", place: "本屋", withCompanion: false });
  assert.deepEqual(findPlanPlaceShortfalls([...base, together], true, [], "ことみちゃん"), [
    "ひとりで出かける outing の行動（withCompanion: false）がありません",
  ]);
  assert.deepEqual(findPlanPlaceShortfalls([...base, alone], true, [], "ことみちゃん"), [
    "companion と一緒の outing の行動（withCompanion: true）がありません",
  ]);
  assert.deepEqual(findPlanPlaceShortfalls([...base, together, alone], true, [], "ことみちゃん"), []);
  // ひとりの日は同行者つきのおでかけを求めない。
  assert.deepEqual(findPlanPlaceShortfalls([...base, alone], true, []), []);
});

// --- おでかけの重み ---

test("おでかけ先はすべて種類を持ち、重複しない", () => {
  assert.equal(new Set(DAILY_OUTING_PLACES).size, DAILY_OUTING_PLACES.length);
  assert.equal(DAILY_OUTING_PLACES.length, 44);
  for (const place of DAILY_OUTING_PLACES) {
    assert.ok(OUTING_STYLES.includes(DAILY_OUTING_PLACE_STYLES[place]), place);
  }
});

test("おでかけの予定の種類を場所の名前から判定する", () => {
  const style = (place: string, activity = "", outingPlaces: string[] = []) =>
    outingStyleOf({ place, activity }, outingPlaces);
  assert.equal(style("駅前の図書館"), "quietEasy");
  assert.equal(style("駅ビルの映画館"), "quietEffort");
  assert.equal(style("隣町の遊園地"), "lively");
  assert.equal(style("近所のコンビニ"), "quietEasy");
  // 「本屋」より長い「古本屋」を先に当てる（どちらも quietEasy だが、照合順の確認）。
  assert.equal(style("駅裏の古本屋"), "quietEasy");
  // 今日のおでかけ先を優先する。聖地巡礼は場所が商店街でも active。
  assert.equal(style("アニメの舞台の商店街", "聖地巡礼で商店街を歩く", ["聖地巡礼"]), "active");
  assert.equal(style("アニメの舞台の商店街", "商店街を歩く"), "lively");
});

test("おでかけの重みは、元気と同行者で上がる", () => {
  for (const style of OUTING_STYLES) {
    assert.ok(outingWeight(style, 60, false) > outingWeight(style, 5, false), style);
    assert.ok(outingWeight(style, 35, true) > outingWeight(style, 35, false), style);
    // 範囲外の energy は端に丸める。
    assert.equal(outingWeight(style, 0, false), outingWeight(style, 15, false));
    assert.equal(outingWeight(style, 100, false), outingWeight(style, 50, false));
  }
  // 元気が無いときは、気軽なおでかけのほうが敷居の高いおでかけより出やすい。
  assert.ok(outingWeight("quietEasy", 5, false) > outingWeight("quietEffort", 5, false));
  assert.ok(outingWeight("quietEffort", 5, false) > outingWeight("active", 5, false));
  // ひとりでも、元気なら外出はそれなりに出る。
  assert.ok(outingWeight("active", 60, false) > 0.5);
});

/** 乱数列を順に返す。尽きたら最後の値を返し続ける。 */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const outingRate = (target: DailyPlan, energy: number, runs = 4000) => {
  let outings = 0;
  for (let i = 0; i < runs; i += 1) {
    const picked = takePlannedEvent(target, "FreeTime", 15, true, energy, sequence(i / runs, 0.5, 0.5));
    if (picked?.event.placeKind === "outing") outings += 1;
  }
  return outings / runs;
};

test("自宅とおでかけの両方があるときは、おでかけの重みで選ぶ", () => {
  const home = event({ place: "自室", placeKind: "home" });
  const solo = plan({ events: [home, event({ place: "隣町の遊園地", placeKind: "outing" })] });
  const together = plan({
    events: [home, event({ place: "隣町の遊園地", placeKind: "outing", withCompanion: true })],
  });

  // 1段目の random() でどちらにするかを決める。境界は 1 / (1 + w)。
  const expected = (w: number) => w / (1 + w);
  const close = (actual: number, target: number) =>
    assert.ok(Math.abs(actual - target) < 0.01, `${actual} vs ${target}`);
  close(outingRate(solo, 5), expected(outingWeight("lively", 5, false)));
  close(outingRate(solo, 60), expected(outingWeight("lively", 60, false)));
  close(outingRate(together, 60), expected(outingWeight("lively", 60, true)));
  assert.ok(outingRate(solo, 60) > outingRate(solo, 5));
  assert.ok(outingRate(together, 35) > outingRate(solo, 35));
});

test("おでかけの予定が増えても、外出率は件数に比例して増えない", () => {
  const home = event({ place: "自室", placeKind: "home" });
  const park = (activity: string) => event({ place: "隣町の遊園地", activity, placeKind: "outing" });
  const one = plan({ events: [home, park("観覧車に乗る")] });
  const three = plan({ events: [home, park("観覧車に乗る"), park("ジェットコースター"), park("お化け屋敷")] });
  assert.ok(Math.abs(outingRate(one, 35) - outingRate(three, 35)) < 0.01);
});

test("片側しか候補が無ければ、重みを付けずに等確率で選ぶ", () => {
  const outingsOnly = plan({
    events: [
      event({ place: "駅前の図書館", placeKind: "outing" }),
      event({ place: "海辺", placeKind: "outing" }),
    ],
  });
  assert.equal(takePlannedEvent(outingsOnly, "FreeTime", 15, true, 0, () => 0)?.index, 0);
  assert.equal(takePlannedEvent(outingsOnly, "FreeTime", 15, true, 0, () => 0.99)?.index, 1);
});

test("予定生成で場所の区分・平日の学校・今日のおでかけ先を指示する", () => {
  const input = {
    botDate: "2026-08-20",
    companion: "ひとり",
    outingPlaces: ["水族館", "古本屋"],
    whatDay: [],
    eventSamples: {},
    worksSection: "",
  };
  const weekday = buildDailyPlanPrompt({ ...input, isWeekend: false });
  const dayOff = buildDailyPlanPrompt({ ...input, isWeekend: true });

  assert.match(weekday, /"placeKind"/);
  assert.match(weekday, /daytime（9〜17時）は学校にいる/);
  assert.match(weekday, /休み時間・昼休みの過ごし方/);
  assert.match(weekday, /今日のおでかけ先は「水族館」「古本屋」/);
  assert.doesNotMatch(weekday, /school の行動は作らないこと/);
  assert.match(dayOff, /school の行動は作らないこと/);
  assert.doesNotMatch(dayOff, /daytime（9〜17時）は学校にいる/);
});

test("描写プロンプトに予定の場所を渡し、場所が無ければ行を出さない", () => {
  const withPlace = buildPlannedEventSection(
    plan(),
    event({ activity: "イルカショーを見る", place: "駅ビルの水族館", placeKind: "outing" }),
  );
  assert.match(withPlace, /予定: イルカショーを見る\n  - 場所: 駅ビルの水族館/);

  const withoutPlace = buildPlannedEventSection(plan(), event({ activity: "お茶を飲む" }));
  assert.doesNotMatch(withoutPlace, /場所:/);
  assert.match(withoutPlace, /予定: お茶を飲む\n  - 今日の主な同行者/);
});

test("withCompanion は true のときだけ true として読む", () => {
  const parsed = parseDailyPlan(
    {
      events: [
        { status: "FreeTime", activity: "水族館へ行く", durationMinutes: 60, withCompanion: true },
        { status: "FreeTime", activity: "本屋へ行く", durationMinutes: 30, withCompanion: "yes" },
        { status: "FreeTime", activity: "ゲームする", durationMinutes: 30 },
      ],
    },
    "2026-08-10",
  );
  assert.deepEqual(parsed?.events.map((item) => item.withCompanion), [true, false, false]);
});
