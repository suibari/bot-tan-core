import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/middleware/errors.js";
import {
  buildEmojiImageRequest,
  characterDescriptions,
  initialChromaKey,
  letteringAspect,
  normalizeEmojiName,
  normalizeEmojiPlan,
  otherChromaKey,
  parseEmojiGenerationInput,
  planPrompt,
} from "../src/services/emojiGenerationPrompt.js";

const rejects = (body: unknown) =>
  assert.throws(() => parseEmojiGenerationInput(body), (e) => e instanceof ApiError && e.status === 400);

test("lettering widens the emoji as the text gets longer", () => {
  assert.equal(letteringAspect("草"), "square");
  assert.equal(letteringAspect("おつ"), "square");
  assert.equal(letteringAspect("わかる"), "wide");
  assert.equal(letteringAspect("LGTM"), "wide");
  assert.equal(letteringAspect("ありがとう"), "long");
  // 結合文字も1文字
  assert.equal(letteringAspect("👍🏽"), "square");
});

test("parseEmojiGenerationInput takes one prompt", () => {
  assert.deepEqual(parseEmojiGenerationInput({ prompt: " 眠そうな\n三毛猫 " }), { prompt: "眠そうな 三毛猫" });
  rejects({ prompt: "" });
  rejects({ prompt: "   " });
  rejects({ prompt: "あ".repeat(101) });
  rejects({});
});

test("normalizeEmojiName fits the Bluemoji name rule", () => {
  assert.equal(normalizeEmojiName("fist_pump_penguin"), "fist_pump_penguin");
  assert.equal(normalizeEmojiName("Fist Pump Penguin!"), "fist_pump_penguin");
  assert.equal(normalizeEmojiName("それな"), "emoji");
  assert.equal(normalizeEmojiName("a".repeat(40)), "a".repeat(32));
  assert.equal(normalizeEmojiName(undefined), "emoji");
});

test("normalizeEmojiPlan sizes lettering by length and drops overly long text", () => {
  assert.deepEqual(
    normalizeEmojiPlan({ subject: "Lettering of それな.", lettering: "「それな」", aspect: "square", name: "sorena", description: "それな" }),
    { name: "sorena", description: "それな", subject: "Lettering of それな.", lettering: "それな", aspect: "wide", outfit: "none" },
  );
  assert.deepEqual(
    normalizeEmojiPlan(
      { subject: 'A "penguin" doing a fist pump.', lettering: "", aspect: "wide", name: "Fist Pump", description: "" },
      "ガッツポーズするペンギン",
    ),
    { name: "fist_pump", description: "ガッツポーズするペンギン", subject: "A penguin doing a fist pump.", aspect: "wide", outfit: "none" },
  );
  assert.deepEqual(normalizeEmojiPlan({ subject: "A cat.", lettering: "あ".repeat(11), aspect: "odd" }), {
    name: "emoji",
    description: "",
    subject: "A cat.",
    aspect: "square",
    outfit: "none",
  });
  assert.equal(normalizeEmojiPlan({ subject: "", lettering: "草" }), undefined);
  assert.equal(normalizeEmojiPlan(undefined), undefined);
});

test("planPrompt keeps lettering verbatim", () => {
  const p = planPrompt("「おつ」って言うねこ");
  assert.match(p, /Request: 「おつ」って言うねこ$/);
  assert.match(p, /copied verbatim without translating/);
});

test("chroma key starts green for subjects close to magenta", () => {
  assert.equal(initialChromaKey("おにぎり"), "magenta");
  assert.equal(initialChromaKey("ピンクのうさぎ"), "green");
  assert.equal(initialChromaKey("a purple cat"), "green");
  assert.equal(otherChromaKey("magenta"), "green");
  assert.equal(otherChromaKey("green"), "magenta");
});

test("buildEmojiImageRequest fixes style and background around the plan", () => {
  const text = buildEmojiImageRequest({
    plan: { name: "sorena", description: "それな", subject: "Lettering of the word それな", lettering: "それな", aspect: "wide", outfit: "none" },
    style: 0,
    key: "green",
  });
  assert.equal(text.width, 1088);
  assert.equal(text.height, 544);
  assert.match(text.prompt, /^suibari style\./);
  assert.match(text.prompt, /Lettering of the word それな\. The text "それな" is written in one horizontal line, in thick bold letters with a white inner outline/);
  assert.match(text.prompt, /pure green \(#00FF00\) chroma key background/);
  assert.deepEqual(text.lora, [["moss-suibari-v1-000006.safetensors", 1.0]]);

  const illust = buildEmojiImageRequest({
    plan: { name: "cat", description: "猫", subject: "A calico cat curled up with a sleepy face. ", aspect: "square", outfit: "none" },
    style: 1,
    key: "magenta",
  });
  assert.equal(illust.width, 768);
  assert.match(illust.prompt, /A calico cat curled up with a sleepy face\. Drawn with a thick dark outline\./);
  assert.doesNotMatch(illust.prompt, /The text/);
  // キャラが出ない絵には構図も全身のネガティブも足さない（ラーメンに「胸から上」は要らない）
  assert.doesNotMatch(illust.prompt, /Upper-body/);
  assert.doesNotMatch(illust.negativePrompt, /full body/);
  assert.match(illust.prompt, /magenta \(#FF00FF\)/);

  // スタイルごとに文が変わる（頼み直しで違う絵にする）
  const styles = new Set(
    [0, 1, 2].map(
      (style) => buildEmojiImageRequest({ plan: { name: "kusa", description: "草", subject: "Lettering", lettering: "草", aspect: "square", outfit: "none" }, style, key: "magenta" }).prompt,
    ),
  );
  assert.equal(styles.size, 3);
});

test("characterDescriptions adds the looks of bot-tan and friends", () => {
  const [bot] = characterDescriptions("フレーフレーと応援するbotたん");
  assert.match(bot, /^Bot-tan, a teenage girl with very long light-blue hair/);
  assert.match(bot, /wearing a loose mint-green sweater/);
  assert.match(characterDescriptions("Latte-chan waving")[0], /^Latte-chan, another girl with very long pink hair/);
  assert.match(characterDescriptions("ことみちゃん")[0], /^Kotomi-chan/);
  // botたんと一緒なら「彼女の犬」、ひとりなら犬だけ
  assert.deepEqual(characterDescriptions("botたんとモルフォ")[1], "Morpho, her big fluffy white Samoyed dog");
  assert.deepEqual(characterDescriptions("モルフォ"), ["Morpho, a big fluffy white Samoyed dog"]);
  assert.deepEqual(characterDescriptions("ねこ"), []);

  const request = buildEmojiImageRequest({
    plan: { name: "cheer", description: "応援", subject: "Bot-tan cheering", lettering: "フレーフレー", aspect: "long", outfit: "none" },
    style: 0,
    key: "magenta",
    characters: characterDescriptions("フレーフレーと応援するbotたん"),
  });
  assert.match(
    request.prompt,
    /Bot-tan cheering\. Upper-body view, from the chest up\. Bot-tan, a teenage girl .*\. The text "フレーフレー"/,
  );
  assert.match(request.negativePrompt, /full body, legs, feet, shoes/);
});

test("characterDescriptions swaps or drops the outfit as requested", () => {
  // 決まった服は、bot の絵と同じ服の文に差し替える
  const [pajamas] = characterDescriptions("パジャマのbotたん", "pajamas");
  assert.match(pajamas, /wearing light-blue long-sleeved pajamas/);
  assert.doesNotMatch(pajamas, /mint-green sweater/);
  // ことみちゃんは制服も持っている
  assert.match(characterDescriptions("制服のことみちゃん", "uniform")[0], /navy-blue blazer/);
  // 持っていない服や決まった服以外は、服を書かない（subject の指定に任せる）
  assert.equal(
    characterDescriptions("水着のラテちゃん", "swimsuit")[0],
    "Latte-chan, another girl with very long pink hair, white cat ears and a white cat tail, green eyes",
  );
  assert.doesNotMatch(characterDescriptions("サンタ服のbotたん", "other")[0], /wearing/);
  // 指定が無ければ署名の1着
  assert.match(characterDescriptions("ラテちゃん")[0], /maid outfit/);
  assert.match(characterDescriptions("ことみちゃん")[0], /idol outfit/);
});

test("normalizeEmojiPlan keeps only known outfits", () => {
  assert.equal(normalizeEmojiPlan({ subject: "Bot-tan in pajamas.", outfit: "pajamas" })?.outfit, "pajamas");
  assert.equal(normalizeEmojiPlan({ subject: "Bot-tan.", outfit: "kimono" })?.outfit, "none");
});
