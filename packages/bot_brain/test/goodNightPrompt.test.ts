import assert from "node:assert/strict";
import test from "node:test";
import { buildGoodNightPrompt, parseGoodNightResponse } from "../src/ai/generateGoodNight.js";

const base = {
  currentMood: "のんびりしていた",
};
const nightVideo = {
  hook: "頑張りすぎた自分を抱きしめて",
  caption: "すいばりさんの「働き方へのこだわり」という投稿を紹介したよ。",
};

test("夜の動画がある日は動画へのコメント欄を求め、材料を渡す", () => {
  const prompt = buildGoodNightPrompt({ ...base, nightVideo });

  assert.match(prompt, /videoCommentJa \/ videoCommentEn/);
  assert.match(prompt, /頑張りすぎた自分を抱きしめて/);
  assert.match(prompt, /すいばりさんの「働き方へのこだわり」/);
  // 出来事スレッドと動画へのコメントで、同じ話が2本に分かれて出ないように。
  assert.match(prompt, /こちらには混ぜないでください/);
});

test("夜の動画が無い日は動画にも、以前のトップポストにも触れない", () => {
  const prompt = buildGoodNightPrompt(base);

  assert.doesNotMatch(prompt, /videoComment/);
  assert.doesNotMatch(prompt, /全肯定されたポスト/);
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

  const withMemory = buildGoodNightPrompt({ ...base, botContext });
  assert.match(withMemory, /botたんの記憶/);
  assert.match(withMemory, /朝ごはん/);
  assert.match(withMemory, /1つか2つだけ拾って/);

  assert.doesNotMatch(
    buildGoodNightPrompt(base),
    /botたんの記憶/,
  );
});

test("今日覚えた言葉があれば候補と言い回しを渡し、無ければ何も足さない", () => {
  const prompt = buildGoodNightPrompt({
    ...base,
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
    buildGoodNightPrompt(base),
    /今日覚えた言葉/,
  );
  assert.doesNotMatch(
    buildGoodNightPrompt({ ...base, learnedTerms: [] }),
    /今日覚えた言葉/,
  );
});

test("片方の言語に両方を詰めないようプロンプトで明示する", () => {
  const prompt = buildGoodNightPrompt(base);

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

test("手元に無いURLを書いた生成は投げ、お部屋のURLだけは通す", () => {
  // 2026-10-06 の現物。表示名「📛 Transgender Mahou Shoujo」が x.com のリンクに化けた。
  const leaked = "https://x.com/TransgenderMahouShoujo 🦊|🌹🌙🌲";
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: `${ja}\n\n${leaked}`, textEn: en })),
    /unexpected URL: https:\/\/x\.com\/TransgenderMahouShoujo/,
  );
  assert.throws(
    () => parseGoodNightResponse(JSON.stringify({ textJa: ja, textEn: `${en}\n\n${leaked}` })),
    /unexpected URL/,
  );

  const room = parseGoodNightResponse(JSON.stringify({
    textJa: `${ja}\nお部屋はこちら https://room.bot-tan.com だよ`,
    textEn: `${en}\nMy room: https://room.bot-tan.com/`,
  }));
  assert.match(room.textJa, /https:\/\/room\.bot-tan\.com/);
});

test("ユーザ名からSNSのURLを作らないようプロンプトで明示する", () => {
  for (const param of [base, { ...base, nightVideo }]) {
    const prompt = buildGoodNightPrompt(param);
    assert.match(prompt, /SNSアカウントのURLを推測して作ることも禁止/);
    assert.doesNotMatch(prompt, /URLはそのまま https:\/\/\.\.\. の形式で本文中に含めて/);
  }
});

const commentJa = "今日の動画では、自分を追い込みがちな人に届けたい投稿を紹介したよ。見てね！";
const commentEn = "In today's video, I shared a post for anyone who pushes themselves too hard. Check it out!";

test("動画がある日は動画へのコメントも日英そろって返す", () => {
  const result = parseGoodNightResponse(
    JSON.stringify({ textJa: ja, textEn: en, videoCommentJa: commentJa, videoCommentEn: commentEn }),
    { withVideo: true },
  );
  assert.equal(result.videoCommentJa, commentJa);
  assert.equal(result.videoCommentEn, commentEn);

  // 動画を渡していない日は、モデルが勝手に書いても使わない。
  const without = parseGoodNightResponse(
    JSON.stringify({ textJa: ja, textEn: en, videoCommentJa: commentJa, videoCommentEn: commentEn }),
  );
  assert.equal(without.videoCommentJa, undefined);
});

test("動画へのコメントにも本文と同じ検査を掛ける", () => {
  const parse = (fields: Record<string, string>) => parseGoodNightResponse(
    JSON.stringify({ textJa: ja, textEn: en, videoCommentJa: commentJa, videoCommentEn: commentEn, ...fields }),
    { withVideo: true },
  );
  assert.throws(() => parse({ videoCommentEn: "" }), /empty video comment/);
  assert.throws(() => parse({ videoCommentJa: commentEn }), /not predominantly Japanese/);
  assert.throws(() => parse({ videoCommentEn: commentJa }), /too much Japanese/);
  assert.throws(() => parse({ videoCommentJa: `${commentJa}\nvideoCommentEn` }), /leaked a field name/);
  assert.throws(() => parse({ videoCommentJa: `${commentJa} https://x.com/someone` }));
});
