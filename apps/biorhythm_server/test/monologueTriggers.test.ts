import assert from "node:assert/strict";
import test from "node:test";
import {
  MONOLOGUE_DAILY_MAX,
  MONOLOGUE_MIN_GAP_MS,
  canPostMonologue,
  detectMonologueTrigger,
  emptyMonologueState,
  monologueProbability,
  normalizeMonologueState,
  pickMonologueReaction,
  shouldAttachMonologueImage,
  monologueImageProbability,
} from "../src/monologueTriggers.js";
import { MONOLOGUE_SCENARIOS, runMonologueScenario, seededRandom } from "../src/monologueScenarios.js";
import { buildMonologuePostRequest } from "../src/scheduledPostRequests.js";

const wake = {
  statusPrev: "Sleep" as const,
  status: "WakeUp" as const,
  hour: 8,
  roomEventCount: 0,
};

test("おはよう済みの後に Sleep から起きたら二度寝明け", () => {
  assert.equal(detectMonologueTrigger({ ...wake, morningPostedBeforeStep: true }), "oversleep-wake");
  assert.equal(detectMonologueTrigger({ ...wake, morningPostedBeforeStep: true, hour: 15 }), "nap-wake");
});

test("その日最初の起床（おはよう前）は二度寝明けにしない", () => {
  assert.equal(detectMonologueTrigger({ ...wake, morningPostedBeforeStep: false }), "status-change");
});

test("来客・切り替わり・何もない、の順に拾う", () => {
  const awake = { statusPrev: "Study" as const, status: "Study" as const, hour: 14, morningPostedBeforeStep: true };
  assert.equal(detectMonologueTrigger({ ...awake, roomEventCount: 1 }), "room-visit");
  assert.equal(detectMonologueTrigger({ ...awake, status: "FreeTime", roomEventCount: 0 }), "status-change");
  assert.equal(detectMonologueTrigger({ ...awake, roomEventCount: 0 }), "idle");
});

test("二度寝明けは100%にせず、前日も撃っていたら半分", () => {
  const base = { status: "WakeUp" as const, hour: 8, energy: 40, trigger: "oversleep-wake" as const };
  const today = monologueProbability({ ...base, firedSameTriggerYesterday: false });
  assert.ok(today > 0.3 && today < 1);
  assert.equal(monologueProbability({ ...base, firedSameTriggerYesterday: true }), today / 2);
});

test("energy が低くても撃つ（気まぐれの energy>=60 とは逆）", () => {
  const args = { status: "FreeTime" as const, hour: 21, trigger: "idle" as const, firedSameTriggerYesterday: false };
  assert.ok(monologueProbability({ ...args, energy: 10 }) > 0.2);
  assert.equal(monologueProbability({ ...args, status: "Sleep", hour: 4, energy: 80 }), 0);
});

test("日次上限・最短間隔・他の投稿と同じ step を守る", () => {
  const now = new Date("2026-10-22T12:00:00+09:00");
  const today = "2026-10-22";
  assert.equal(canPostMonologue({ state: emptyMonologueState(), today, now, postedOtherThisStep: true }), false);
  assert.equal(
    canPostMonologue({ state: { ...emptyMonologueState(), day: today, count: MONOLOGUE_DAILY_MAX }, today, now, postedOtherThisStep: false }),
    false,
  );
  // 日が変わればカウントは戻る。
  assert.equal(
    canPostMonologue({ state: { ...emptyMonologueState(), day: "2026-10-21", count: MONOLOGUE_DAILY_MAX }, today, now, postedOtherThisStep: false }),
    true,
  );
  const recent = new Date(now.getTime() - MONOLOGUE_MIN_GAP_MS + 60_000).toISOString();
  assert.equal(
    canPostMonologue({ state: { ...emptyMonologueState(), lastPostedAt: recent }, today, now, postedOtherThisStep: false }),
    false,
  );
});

test("反応の型は直前と同じものを選ばない", () => {
  const random = seededRandom(1);
  let last: string | undefined;
  for (let i = 0; i < 200; i++) {
    const reaction = pickMonologueReaction({ trigger: "oversleep-wake", hour: 8, isWeekend: false, energy: 40, lastReactionId: last, random });
    assert.notEqual(reaction.id, last);
    last = reaction.id;
  }
});

test("平日の遅い二度寝は焦りが多く、休日は至福が多い", () => {
  const count = (isWeekend: boolean, id: string) => {
    const random = seededRandom(7);
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      if (pickMonologueReaction({ trigger: "oversleep-wake", hour: 9, isWeekend, energy: 40, random }).id === id) n++;
    }
    return n;
  };
  assert.ok(count(false, "panic") > count(true, "panic") * 3);
  assert.ok(count(true, "bliss") > count(false, "bliss") * 3);
});

test("絵は元気があるときほど描く", () => {
  assert.ok(monologueImageProbability(10) < monologueImageProbability(40));
  assert.ok(monologueImageProbability(40) < monologueImageProbability(60));
  assert.equal(monologueImageProbability(100), 0.3);
  assert.ok(monologueImageProbability(0) > 0);
});

test("壊れた state は初期値から数え直す", () => {
  assert.deepEqual(normalizeMonologueState(null), emptyMonologueState());
  const state = normalizeMonologueState({ day: "2026-10-22", count: -3, recentTexts: ["a", 1, "b"] });
  assert.equal(state.count, 0);
  assert.deepEqual(state.recentTexts, ["a", "b"]);
});

test("ひとりごとのリクエストは Nagi だけで、ハッシュタグも bsky も持たない", () => {
  const request = buildMonologuePostRequest({ generated: { textJa: "ねむ…", textEn: "so sleepy..." } });
  assert.equal(request.kind, "monologue");
  assert.deepEqual(Object.keys(request.contentByTarget), ["nagi"]);
  assert.equal(request.contentByTarget.nagi?.text, "ねむ…");
  assert.deepEqual(request.contentByTarget.nagi?.translations, [{ lang: "en", text: "so sleepy..." }]);
});

/**
 * 目標は「1日4〜8件」。架空の1日を多数のシードで回して、平均がその帯に入るかを見る。
 * 本番の step 数は日によって違うので、ここは確率表を大きく崩していないかの番人。
 */
for (const scenario of MONOLOGUE_SCENARIOS) {
  test(`架空の1日（${scenario.name}）で件数・間隔・二度寝明けが想定どおり`, async () => {
    const runs = 500;
    let total = 0;
    let oversleep = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const { firings } = await runMonologueScenario(scenario, seededRandom(seed));
      total += firings.length;
      assert.ok(firings.length <= MONOLOGUE_DAILY_MAX);
      for (let i = 1; i < firings.length; i++) {
        assert.ok(firings[i].at.getTime() - firings[i - 1].at.getTime() >= MONOLOGUE_MIN_GAP_MS);
      }
      for (const firing of firings) assert.equal(firing.step.otherPost, undefined);
      if (firings.some((f) => f.trigger === "oversleep-wake")) oversleep++;
    }
    const average = total / runs;
    assert.ok(average >= 3 && average <= 8, `average=${average}`);
    // 二度寝明けは毎回ではない（機械的にしない）が、半分前後は拾う。
    assert.ok(oversleep / runs > 0.35 && oversleep / runs < 0.75, `oversleep=${oversleep / runs}`);
  });
}
