import assert from "node:assert/strict";
import test from "node:test";
import type { Content } from "@google/genai";
import {
  buildConversationPrompt,
  prepareConversationHistory,
} from "../src/ai/conversation.js";
import { formatBotContext } from "../src/ai/util.js";

const turn = (role: "user" | "model", text: string): Content => ({
  role,
  parts: [{ text }],
});

test("100ターンの履歴では直前の質問をGeminiへ残す", () => {
  const history = Array.from({ length: 50 }, (_, index) => [
    turn("user", `user-${index}`),
    turn(
      "model",
      index === 49
        ? "お家でどんな風にリラックスするのかな？"
        : `model-${index}`,
    ),
  ]).flat();

  const prepared = prepareConversationHistory(history);

  assert.equal(prepared.length, 100);
  assert.equal(
    prepared.at(-1)?.parts?.[0]?.text,
    "お家でどんな風にリラックスするのかな？",
  );
});

test("上限超過時も最新50往復をrole順に残す", () => {
  const history = Array.from({ length: 60 }, (_, index) => [
    turn("user", `user-${index}`),
    turn("model", `model-${index}`),
  ]).flat();

  const prepared = prepareConversationHistory(history);

  assert.equal(prepared.length, 100);
  assert.equal(prepared[0]?.role, "user");
  assert.equal(prepared[0]?.parts?.[0]?.text, "user-10");
  assert.equal(prepared.at(-1)?.parts?.[0]?.text, "model-59");
});

test("日本語会話は質問を強制せず再質問と冗長な返答を禁止する", () => {
  const prompt = buildConversationPrompt({
    follower: {
      did: "did:plc:test",
      handle: "test.example",
      displayName: "テスト",
    },
    posts: ["Botたんもゆっくり休むといい"],
    langStr: "日本語",
    botContext: {
      datetime: "2026年7月30日19時15分",
      weather: "晴れ",
      botActivity: "友達とカフェにいるよ",
      botActivityEn: "I'm at a cafe with friends.",
      botEnergy: 11,
      recentActivities: [
        { at: "2026-07-30T03:00:00.000Z", activity: "朝ごはん", activityEn: "Breakfast" },
        { at: "2026-07-30T06:00:00.000Z", activity: "お散歩", activityEn: "A walk" },
      ],
    },
  });

  assert.match(prompt, /毎回質問で終える必要はありません/);
  assert.match(prompt, /意味的にほぼ同じ質問/);
  assert.match(prompt, /以前の質問に答えず別の話題へ進んだ場合/);
  assert.match(prompt, /休息の勧め/);
  assert.match(prompt, /原則2〜4文、300文字以内/);
  assert.match(prompt, /必要な場合だけ参照する背景情報/);
  assert.match(prompt, /時系列を推測で進めない/);
  assert.match(prompt, /直近24時間の行動履歴/);
  assert.match(prompt, /朝ごはん/);
  assert.match(prompt, /現在の状況を過去にも続いていたことにしたり/);
});

test("英語会話にも同じ再質問防止と簡潔さを適用する", () => {
  const prompt = buildConversationPrompt({
    follower: {
      did: "did:plc:test",
      handle: "test.example",
      displayName: "Test",
    },
    posts: ["You should get some rest too."],
    langStr: "English",
  });

  assert.match(prompt, /do not need to end every reply with a question/i);
  assert.match(prompt, /semantically equivalent rewording/i);
  assert.match(prompt, /encouragement to rest/i);
  assert.match(prompt, /2–4 sentences/);
});

test("現在状況は必須話題ではなく繰り返さない背景情報として渡す", () => {
  const context = {
    datetime: "2026年7月30日19時15分",
    weather: "晴れ",
    botActivity: "友達とカフェにいるよ",
    botActivityEn: "I'm at a cafe with friends.",
    botEnergy: 11,
    recentActivities: [
      { at: "2026-07-30T03:00:00.000Z", activity: "朝ごはん", activityEn: "Breakfast" },
    ],
  };

  const ja = formatBotContext(context, "日本語", {
    conversationHistoryAware: true,
  });
  const en = formatBotContext(context, "English", {
    conversationHistoryAware: true,
  });

  assert.match(ja, /必要な場合だけ参照する背景情報/);
  assert.match(ja, /すでに触れた状況は繰り返さず/);
  assert.match(ja, /時系列を推測で進めない/);
  assert.match(en, /use only when needed/i);
  assert.match(en, /do not repeat a situation/i);
  assert.match(en, /invent how this snapshot progressed/i);
  assert.match(ja, /記録された事実・古い順/);
  assert.match(en, /recorded facts; oldest first/i);
});

test("会話以外のリプライにも現在状況と過去の行動履歴を渡す", () => {
  const context = formatBotContext(
    {
      datetime: "2026年7月30日19時15分",
      weather: "晴れ",
      botActivity: "友達とカフェにいるよ",
      botActivityEn: "I'm at a cafe with friends.",
      botEnergy: 11,
      recentActivities: [
        { at: "2026-07-30T03:00:00.000Z", activity: "朝ごはん", activityEn: "Breakfast" },
      ],
    },
    "日本語",
  );

  assert.match(context, /参考にして返答をパーソナライズしてください/);
  assert.match(context, /直近24時間の行動履歴/);
  assert.match(context, /記録外の出来事を足したり/);
  assert.doesNotMatch(context, /時系列を推測で進めない/);
});

test("行動履歴の時刻はJSTの壁時計で出し、UTCのISOを残さない", () => {
  const context = formatBotContext(
    {
      datetime: "2026年8月10日14時0分",
      weather: "晴れ",
      botActivity: "課題をやってるよ",
      botActivityEn: "Doing homework.",
      botEnergy: 60,
      recentActivities: [
        { at: "2026-08-10T02:05:00.000Z", activity: "朝ごはん", activityEn: "Breakfast" },
      ],
    },
    "日本語",
    { now: new Date("2026-08-10T05:00:00Z") },
  );

  assert.match(context, /今日 11:05（2時間前）: 朝ごはん/);
  // 同じプロンプト内の「日時」はJST壁時計なので、ISOが混ざると9時間ずれて読まれる。
  assert.doesNotMatch(context, /\dT\d{2}:\d{2}/);
});

test("行動履歴は直近20件までに丸める", () => {
  const recentActivities = Array.from({ length: 40 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 7, 10, 0, index)).toISOString(),
    activity: `活動${index}`,
    activityEn: `activity-${index}`,
  }));
  const context = formatBotContext(
    {
      datetime: "2026年8月10日14時0分",
      weather: "晴れ",
      botActivity: "課題をやってるよ",
      botActivityEn: "Doing homework.",
      botEnergy: 60,
      recentActivities,
    },
    "日本語",
    { now: new Date("2026-08-10T05:00:00Z") },
  );

  assert.equal(context.match(/^- .*: 活動\d+$/gm)?.length, 20);
  assert.match(context, /活動39/);
  assert.doesNotMatch(context, /活動19\b/);
});

test("surfaceを渡すとNagiがホーム・Blueskyが出張先として出る", () => {
  const base = {
    datetime: "2026年8月10日14時0分",
    weather: "晴れ",
    botActivity: "課題をやってるよ",
    botActivityEn: "Doing homework.",
    botEnergy: 60,
  };

  assert.match(
    formatBotContext({ ...base, surface: "nagi" }, "日本語"),
    /いまいる場所：ホームのNagi/,
  );
  assert.match(
    formatBotContext({ ...base, surface: "bluesky" }, "日本語"),
    /いまいる場所：出張先のBluesky/,
  );
  assert.match(
    formatBotContext({ ...base, surface: "bluesky" }, "English"),
    /home is Nagi/,
  );
  // 定期ポストは両ネットワークへ同一本文を配るので、surface 未設定なら場所に触れない。
  assert.doesNotMatch(formatBotContext(base, "日本語"), /いまいる場所/);
});

test("定期ポスト向けは記憶の見出しと使い方のルールを付ける", () => {
  const base = {
    datetime: "2026年8月10日14時0分",
    weather: "晴れ",
    botActivity: "課題をやってるよ",
    botActivityEn: "Doing homework.",
    botEnergy: 60,
    recentActivities: [
      { at: "2026-08-10T02:05:00.000Z", activity: "朝ごはん", activityEn: "Breakfast" },
    ],
  };

  const ja = formatBotContext(base, "日本語", { purpose: "scheduledPost" });
  const en = formatBotContext(base, "English", { purpose: "scheduledPost" });

  assert.match(ja, /botたんの記憶/);
  assert.match(ja, /1つか2つだけ拾って/);
  assert.match(ja, /記録にない出来事を作らないこと/);
  assert.match(en, /Bot-tan's memory/);
  assert.match(en, /only one or two entries/i);
  // リプライ向けの文言は混ざらない。
  assert.doesNotMatch(ja, /返答をパーソナライズ/);
});
