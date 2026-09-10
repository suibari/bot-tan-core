import assert from "node:assert/strict";
import test from "node:test";
import type { BotContext } from "@bsky-affirmative-bot/shared-configs";
import { goodNightImageSource, todayActivityLines } from "../src/ScheduledPostCoordinator.js";

function context(
  activities: { at: string; activity: string }[],
): BotContext {
  return {
    datetime: "",
    weather: "",
    botActivity: "",
    botActivityEn: "",
    botEnergy: 50,
    recentActivities: activities.map((item) => ({
      ...item,
      activityEn: `${item.activity} (en)`,
    })),
  };
}

test("今日のbot日ぶんだけを、JSTの時刻付きで並べる", () => {
  const now = new Date("2026-09-08T22:30:00+09:00");
  const lines = todayActivityLines(
    context([
      { at: "2026-09-08T12:40:00+09:00", activity: "ことみちゃんと屋上でお弁当を食べた" },
      { at: "2026-09-08T19:30:00+09:00", activity: "モルフォとソファでだらだらしていた" },
    ]),
    now,
  );
  assert.match(lines, /### 今日あったこと/);
  assert.match(lines, /- 12:40 ことみちゃんと屋上でお弁当を食べた/);
  assert.match(lines, /- 19:30 モルフォとソファでだらだらしていた/);
});

test("bot日は4時始まりなので、深夜のおやすみポストでも昨日の夜を拾わない", () => {
  // 9/9 の 1:00 に投稿しても、bot 日は 9/8 04:00 開始のまま。
  const now = new Date("2026-09-09T01:00:00+09:00");
  const lines = todayActivityLines(
    context([
      // bot 日の前（9/8 の 3:00）。拾ってはいけない。
      { at: "2026-09-08T03:00:00+09:00", activity: "前の日の夜ふかし" },
      { at: "2026-09-08T15:00:00+09:00", activity: "図書室で本を読んだ" },
      { at: "2026-09-09T00:30:00+09:00", activity: "歯をみがいた" },
    ]),
    now,
  );
  assert.doesNotMatch(lines, /前の日の夜ふかし/);
  assert.match(lines, /図書室で本を読んだ/);
  assert.match(lines, /歯をみがいた/);
});

test("連続する同じ行動は潰す（並ぶとそこが今日いちばんの場面に見える）", () => {
  const now = new Date("2026-09-08T22:30:00+09:00");
  const lines = todayActivityLines(
    context([
      { at: "2026-09-08T14:00:00+09:00", activity: "本を読んだ" },
      { at: "2026-09-08T14:30:00+09:00", activity: "本を読んだ" },
      { at: "2026-09-08T15:00:00+09:00", activity: "本を読んだ" },
      { at: "2026-09-08T16:00:00+09:00", activity: "散歩した" },
    ]),
    now,
  );
  assert.equal(lines.match(/本を読んだ/g)?.length, 1);
  assert.match(lines, /散歩した/);
});

test("材料が無ければ何も足さない（本文だけで描かせる）", () => {
  const now = new Date("2026-09-08T22:30:00+09:00");
  assert.equal(todayActivityLines(undefined, now), "");
  assert.equal(todayActivityLines(context([]), now), "");
  // bot 日の外しか無いときも空。
  assert.equal(
    todayActivityLines(context([{ at: "2026-09-07T10:00:00+09:00", activity: "きのう" }]), now),
    "",
  );
});

test("壊れた at は落とす（NaN の時刻を本文へ出さない）", () => {
  const now = new Date("2026-09-08T22:30:00+09:00");
  const lines = todayActivityLines(
    context([
      { at: "not a date", activity: "こわれた記録" },
      { at: "2026-09-08T15:00:00+09:00", activity: "図書室で本を読んだ" },
    ]),
    now,
  );
  assert.doesNotMatch(lines, /こわれた記録/);
  assert.doesNotMatch(lines, /NaN/);
  assert.match(lines, /図書室で本を読んだ/);
});

test("本文にも見出しを付けて渡す（地の文だと就寝の枠が主題に見える）", () => {
  const now = new Date("2026-09-08T22:30:00+09:00");
  const source = goodNightImageSource(
    "みんな、おやすみなさい！わたし、もう眠りにつくね。",
    context([{ at: "2026-09-08T15:00:00+09:00", activity: "図書室で本を読んだ" }]),
    now,
  );
  assert.match(source, /^### おやすみポストの本文/);
  assert.match(source, /眠ること自体は主題ではない/);
  assert.match(source, /みんな、おやすみなさい/);
  // 行動履歴は本文のうしろ。順序が入れ替わると材料の読まれ方が変わる。
  assert.ok(source.indexOf("図書室で本を読んだ") > source.indexOf("おやすみなさい"));
});
