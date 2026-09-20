import assert from "node:assert/strict";
import test from "node:test";
import { buildGoodNightPrompt, parseGoodNightResponse } from "../src/ai/generateGoodNight.js";

const base = {
  currentMood: "のんびりしていた",
  topPost: "今日はいいことがあった",
};

test("Nagi選出時はリポスト済みと説明せずURLの追記をシステムへ任せる", () => {
  const prompt = buildGoodNightPrompt({ ...base, topPostNetwork: "nagi" });

  assert.match(prompt, /全肯定されたポストはNagiの投稿/);
  assert.match(prompt, /リポスト済みとは書かない/);
  assert.match(prompt, /スレッドURLはシステムが本文末尾に追加/);
});

test("Bluesky選出時は既存どおりリポスト済みの感想を求める", () => {
  const prompt = buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" });

  assert.match(prompt, /リポスト済みなので、感想のみ/);
  assert.doesNotMatch(prompt, /全肯定されたポストはNagiの投稿/);
});

test("botContext があれば今日の記憶を、無ければ何も足さない", () => {
  const botContext = {
    datetime: "2026年8月10日22時0分",
    weather: "晴れ",
    botActivity: "ソファでのんびりしてるよ",
    botActivityEn: "Relaxing on the couch.",
    botEnergy: 30,
    recentActivities: [
      {
        at: "2026-08-10T02:05:00.000Z",
        activity: "全肯定たんは、朝ごはんを食べています。",
        activityEn: "Bot-tan is having breakfast.",
      },
    ],
  };

  const withMemory = buildGoodNightPrompt({ ...base, topPostNetwork: "bsky", botContext });
  assert.match(withMemory, /botたんの記憶/);
  assert.match(withMemory, /朝ごはん/);
  assert.match(withMemory, /1つか2つだけ拾って/);

  assert.doesNotMatch(
    buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" }),
    /botたんの記憶/,
  );
});

test("今日覚えた言葉があれば候補と言い回しを渡し、無ければ何も足さない", () => {
  const prompt = buildGoodNightPrompt({
    ...base,
    topPostNetwork: "bsky",
    learnedTerms: [
      { label: "葬送のフリーレン", relation: "recommended" },
      { label: "ぬい活", relation: "liked" },
    ],
  });

  assert.match(prompt, /今日はみんなから〇〇と〇〇を教えてもらったよ/);
  assert.match(prompt, /「葬送のフリーレン」（おすすめされた）/);
  assert.match(prompt, /「ぬい活」（好きだと聞いた）/);
  // 知ったばかりの言葉なので、説明も候補外の補完もさせない。
  assert.match(prompt, /候補に無い言葉を足したり、表記を変えたり/);
  // 教えてくれた人は「みんな」に畳む。
  assert.match(prompt, /名前・投稿内容・URLは書かず/);

  assert.doesNotMatch(
    buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" }),
    /今日覚えた言葉/,
  );
  assert.doesNotMatch(
    buildGoodNightPrompt({ ...base, topPostNetwork: "bsky", learnedTerms: [] }),
    /今日覚えた言葉/,
  );
});

test("片方の言語に両方を詰めないようプロンプトで明示する", () => {
  const prompt = buildGoodNightPrompt({ ...base, topPostNetwork: "bsky" });

  assert.match(prompt, /textJaには日本語だけ、textEnには英語だけ/);
  assert.match(prompt, /フィールド名やラベル、前置きを含めてはいけません/);
});

const ja = "みんな、おやすみなさい！今日もいい一日だったよ。ゆっくり休んでね！✨";
const en = "Good night, everyone! Today was a lovely day. Sleep well! ✨";

test("正しい構造化JSONはそのまま日英に分かれる", () => {
  const result = parseGoodNightResponse(JSON.stringify({ textJa: ja, textEn: en, selectedGiftIndex: 1 }));

  assert.equal(result.textJa, ja);
  assert.equal(result.textEn, en);
  assert.equal(result.selectedGiftIndex, 1);
});

test("```json フェンス付きでも読める", () => {
  const result = parseGoodNightResponse("```json\n" + JSON.stringify({ textJa: ja, textEn: en }) + "\n```");

  assert.equal(result.textJa, ja);
  assert.equal(result.textEn, en);
  assert.equal(result.selectedGiftIndex, undefined);
});

test("壊れた生成は投稿させず投げる", () => {
  // 2026-09-05 の現物。ラベル付きプレーンテキストがそのまま1本の投稿として公開された。
  assert.throws(() => parseGoodNightResponse(`${en}\n\ntextJa\n${ja}`), /invalid JSON/);
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: ja, textEn: "" })),
    /empty required field/,
  );
  // 構造は正しいが中身が入れ違っている場合。
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: en, textEn: en })),
    /textJa is not predominantly Japanese/,
  );
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: ja, textEn: ja })),
    /textEn contains too much Japanese/,
  );
  // JSON としては正しいが、ラベルごと1つの欄へ日英を詰めた形。
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: `${en}\n\ntextJa\n${ja}`, textEn: en })),
    /leaked a field name/,
  );
});
