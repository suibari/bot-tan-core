import assert from "node:assert/strict";
import test from "node:test";
import {
  isSleepingPeriod,
  shouldConsiderWhimsicalPost,
  shouldPostGoodMorning,
  shouldPostGoodNight,
} from "../src/scheduledPostGate.js";

/** bot 日は4時始まり。おやすみは D に、その翌朝のおはようは D+1 に記録される。 */
const D = "2026-08-04";
const NEXT = "2026-08-05";

// --- isSleepingPeriod ---

test("おやすみを言った直後は就寝中", () => {
  // その朝のおはようは同じ bot 日 D に記録されている。
  assert.equal(isSleepingPeriod(D, D), true);
});

test("bot 日がロールオーバーしても、おはようを言うまでは就寝中のまま", () => {
  // 4時をまたいで today が D+1 になっても、判定材料は2つの投稿日だけなので変わらない。
  // 旧実装はここで false に落ちていた。
  assert.equal(isSleepingPeriod(D, D), true);
});

test("翌朝のおはようを言ったら就寝中ではない", () => {
  assert.equal(isSleepingPeriod(D, NEXT), false);
});

test("まだ一度もおやすみを言っていなければ就寝中ではない", () => {
  assert.equal(isSleepingPeriod(undefined, undefined), false);
  assert.equal(isSleepingPeriod(undefined, D), false);
});

test("おやすみだけ済んでおはようの記録がなければ就寝中", () => {
  assert.equal(isSleepingPeriod(D, undefined), true);
});

// --- shouldPostGoodMorning ---

test("遷移していなくても、起きていてその日未投稿なら撃つ", () => {
  // 前夜から起きっぱなしで WakeUp を経由しなかったケース。旧実装の撃ち漏らし。
  assert.equal(
    shouldPostGoodMorning({ status: "FreeTime", today: NEXT, lastGoodMorningPostDate: D }),
    true,
  );
});

test("起床直後（WakeUp）でももちろん撃つ", () => {
  assert.equal(
    shouldPostGoodMorning({ status: "WakeUp", today: NEXT, lastGoodMorningPostDate: D }),
    true,
  );
});

test("寝ている間は撃たない", () => {
  assert.equal(
    shouldPostGoodMorning({ status: "Sleep", today: NEXT, lastGoodMorningPostDate: D }),
    false,
  );
});

test("同じ bot 日に撃っていれば撃たない", () => {
  assert.equal(
    shouldPostGoodMorning({ status: "Study", today: NEXT, lastGoodMorningPostDate: NEXT }),
    false,
  );
});

test("寝坊して昼に起きた日でも、未投稿なら撃つ", () => {
  // 時刻は判定材料に入らない。10時を過ぎたら諦める旧仕様との違い。
  assert.equal(
    shouldPostGoodMorning({ status: "Relax", today: NEXT, lastGoodMorningPostDate: D }),
    true,
  );
});

// --- shouldPostGoodNight ---

test("遷移した step を逃しても、夜に寝ていてその日未投稿なら撃つ", () => {
  // 2026-09-14: 再起動直後の step で Sleep に遷移し、以降は Sleep → Sleep だけで撃ち漏らした。
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 23, today: D, lastGoodNightPostDate: "2026-08-03" }),
    true,
  );
});

test("日付をまたいだ深夜でも、同じ bot 日に撃っていれば撃たない", () => {
  // 23時に撃った夜の2時。0〜3時は前日の bot 日なので today は D のまま。
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 2, today: D, lastGoodNightPostDate: D }),
    false,
  );
});

test("起きている間は夜でも撃たない", () => {
  assert.equal(
    shouldPostGoodNight({ status: "FreeTime", hour: 23, today: D, lastGoodNightPostDate: undefined }),
    false,
  );
});

test("夜の時間帯の外で寝ていても撃たない", () => {
  // 朝の二度寝や夕方の昼寝。
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 7, today: D, lastGoodNightPostDate: "2026-08-03" }),
    false,
  );
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 20, today: D, lastGoodNightPostDate: "2026-08-03" }),
    false,
  );
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 4, today: NEXT, lastGoodNightPostDate: D }),
    false,
  );
});

test("夜の時間帯の境界（21時・3時）では撃つ", () => {
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 21, today: D, lastGoodNightPostDate: undefined }),
    true,
  );
  assert.equal(
    shouldPostGoodNight({ status: "Sleep", hour: 3, today: D, lastGoodNightPostDate: undefined }),
    true,
  );
});

// --- shouldConsiderWhimsicalPost ---

const awake = {
  status: "FreeTime" as const,
  energy: 100,
  lastGoodNightPostDate: D,
  lastGoodMorningPostDate: NEXT,
  isDevelopment: false,
};

test("起きていて元気なら抽選に進む", () => {
  assert.equal(shouldConsiderWhimsicalPost(awake), true);
});

test("就寝中は元気が満タンでも抽選に進まない", () => {
  // おやすみを言ったあと二度寝せず起きていた場合。旧実装はここが素通りしていた。
  assert.equal(
    shouldConsiderWhimsicalPost({ ...awake, lastGoodMorningPostDate: D }),
    false,
  );
});

test("元気が下限に届かなければ抽選に進まない", () => {
  assert.equal(shouldConsiderWhimsicalPost({ ...awake, energy: 59 }), false);
  assert.equal(shouldConsiderWhimsicalPost({ ...awake, energy: 60 }), true);
});

test("寝ている間は抽選に進まない", () => {
  assert.equal(shouldConsiderWhimsicalPost({ ...awake, status: "Sleep" }), false);
});

test("開発時はすべてバイパスする", () => {
  assert.equal(
    shouldConsiderWhimsicalPost({
      ...awake,
      status: "Sleep",
      energy: 0,
      lastGoodMorningPostDate: D,
      isDevelopment: true,
    }),
    true,
  );
});

// --- 順序の回帰テスト ---

test("おはようを撃った step では、同じ step で定期つぶやきに進めない", () => {
  // step() は おはよう → 定期つぶやき の順に評価する。おはようが -60 するので、
  // 上限100のエネルギーでは定期つぶやきの下限60を必ず割り込む。
  const before = {
    status: "WakeUp" as const,
    energy: 100,
    lastGoodNightPostDate: D,
    lastGoodMorningPostDate: D,
    isDevelopment: false,
  };
  assert.equal(
    shouldPostGoodMorning({
      status: before.status,
      today: NEXT,
      lastGoodMorningPostDate: before.lastGoodMorningPostDate,
    }),
    true,
  );

  const afterMorningPost = {
    ...before,
    energy: before.energy - 60,
    lastGoodMorningPostDate: NEXT,
  };
  assert.equal(shouldConsiderWhimsicalPost(afterMorningPost), false);
});
