import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_TAN_OUTFITS,
  botOutfitSpec,
  casualOutfitTags,
  chooseBotOutfit,
  cleanCasualTags,
  parseSceneCues,
  resetCasualOutfitCacheForTest,
  type SceneCues,
} from "../src/ai/botOutfit.js";
import { buildImagePrompt, normalizeScenePlan, type ImageScenePlan } from "../src/ai/buildImagePrompt.js";

const cues = (patch: Partial<SceneCues> = {}): SceneCues => ({ place: "home", swimming: false, stated: "", ...patch });
// 2026-10-22（木）と 2026-10-25（日）。時刻は JST。
const weekday = (hm: string) => new Date(`2026-10-22T${hm}:00+09:00`);
const sunday = (hm: string) => new Date(`2026-10-25T${hm}:00+09:00`);

test("学校は制服、家は昼が私服で21時以降と寝起きはパジャマ", () => {
  assert.equal(chooseBotOutfit({ cues: cues({ place: "school" }), now: weekday("10:00") }), "uniform");
  assert.equal(chooseBotOutfit({ cues: cues(), now: sunday("14:00") }), "casual");
  assert.equal(chooseBotOutfit({ cues: cues(), now: weekday("22:00") }), "pajamas");
  assert.equal(chooseBotOutfit({ cues: cues(), now: weekday("05:30") }), "pajamas");
  assert.equal(chooseBotOutfit({ cues: cues(), status: "WakeUp", now: sunday("10:45") }), "pajamas");
  assert.equal(chooseBotOutfit({ cues: cues({ place: "school" }), status: "Sleep", now: weekday("13:00") }), "pajamas");
});

test("19〜21時はまだ私服（夕ごはんやゲームの時間）", () => {
  assert.equal(chooseBotOutfit({ cues: cues(), now: sunday("19:00") }), "casual");
  assert.equal(chooseBotOutfit({ cues: cues(), status: "Relax", now: weekday("20:59") }), "casual");
  assert.equal(chooseBotOutfit({ cues: cues(), now: weekday("21:00") }), "pajamas");
  // お風呂上がりならシーン変換が clothing=pajamas を返す。
  assert.equal(chooseBotOutfit({ cues: cues({ stated: "pajamas" }), now: weekday("19:30") }), "pajamas");
});

test("おでかけは平日なら制服のまま、休日は私服", () => {
  assert.equal(chooseBotOutfit({ cues: cues({ place: "outing" }), now: weekday("17:20") }), "uniform");
  assert.equal(chooseBotOutfit({ cues: cues({ place: "outing" }), now: sunday("13:30") }), "casual");
});

test("本文が明記した服と、泳いでいる場面が優先される", () => {
  // 「飛び起きて制服に着替えている」の WakeUp。
  assert.equal(chooseBotOutfit({ cues: cues({ stated: "uniform" }), status: "WakeUp", now: weekday("08:05") }), "uniform");
  assert.equal(chooseBotOutfit({ cues: cues({ place: "outing", swimming: true, stated: "casual" }), now: sunday("13:00") }), "swimsuit");
});

test("手がかりが読めなければ「家・泳いでいない・書かれていない」に倒す", () => {
  assert.deepEqual(parseSceneCues({}), cues());
  assert.deepEqual(parseSceneCues({ place: "School", swimming: "yes", clothing: "pajamas" }), cues({ place: "school", stated: "pajamas" }));
  assert.deepEqual(parseSceneCues({ place: "moon", clothing: "not stated" }), cues());
});

test("シーンのタグから服を落とし、手がかりを読む", () => {
  const plan = normalizeScenePlan({
    pose: ["sitting"],
    expression: ["smile"],
    action: ["eating", "wearing school uniform"],
    setting: ["indoors", "cafe"],
    objects: ["parfait", "cardigan"],
    companions: [],
    framing: "upper-body",
    outdoor: false,
    place: "outing",
    swimming: false,
    clothing: "not stated",
  });
  assert.deepEqual(plan.action, ["eating"]);
  assert.deepEqual(plan.objects, ["parfait"]);
  assert.deepEqual(plan.cues, cues({ place: "outing" }));
});

const plan: ImageScenePlan = {
  pose: ["sitting"],
  expression: ["smile"],
  action: ["eating"],
  setting: ["indoors", "living room"],
  objects: ["snacks"],
  companions: [],
  framing: "upper-body",
  outdoor: false,
  characters: [],
  botTan: true,
};

test("選んだ服が制服の代わりに入り、服のネガティブが付く", () => {
  const built = buildImagePrompt(plan, "crayon-diary", [], { outfit: botOutfitSpec("casual") })!;
  assert.match(built.prompt, /mint green cardigan/);
  assert.doesNotMatch(built.prompt, /school uniform/);
  assert.match(built.negativePrompt, /school uniform, neck ribbon, wings/);
});

test("服を渡さなければ従来どおり制服", () => {
  const built = buildImagePrompt(plan, "crayon-diary")!;
  assert.match(built.prompt, new RegExp(BOT_TAN_OUTFITS.uniform.tags));
});

test("パジャマの絵では画風の寝具ネガティブから pajamas を外す", () => {
  const pajamas = buildImagePrompt(plan, "crayon-diary", [], { outfit: botOutfitSpec("pajamas") })!;
  assert.match(pajamas.prompt, /light blue pajamas/);
  assert.doesNotMatch(pajamas.negativePrompt, /(^|, )pajamas(,|$)/);
  const casual = buildImagePrompt(plan, "crayon-diary", [], { outfit: botOutfitSpec("casual") })!;
  assert.match(casual.negativePrompt, /(^|, )pajamas(,|$)/);
});

test("2人の絵では服のネガティブを足さない（仲間の服まで消える）", () => {
  const built = buildImagePrompt({ ...plan, companions: ["kotomi-chan"] }, "crayon-diary", [], {
    outfit: botOutfitSpec("casual"),
  })!;
  assert.doesNotMatch(built.negativePrompt, /neck ribbon/);
  assert.doesNotMatch(built.negativePrompt, /fairy wings/);
  assert.match(built.regions[0].prompt, /mint green cardigan/);
  assert.doesNotMatch(built.regions[1].prompt, /mint green cardigan/);
});

test("予定表の私服は危ない語・制服・ほかの子の署名の服を落とす", () => {
  assert.deepEqual(
    cleanCasualTags(["Beige_Sweater", "blue denim skirt", "school uniform", "pink shirt", "long hair", "crop top", "beige sweater"]),
    ["beige sweater", "blue denim skirt"],
  );
});

test("私服の変換は同じ文なら1回だけ、失敗したら既定の私服", async () => {
  resetCasualOutfitCacheForTest();
  let calls = 0;
  const convert = async () => {
    calls++;
    return ["beige sweater", "blue denim skirt"];
  };
  assert.equal(await casualOutfitTags("ベージュのニットに青いデニムスカート", convert), "beige sweater, blue denim skirt");
  assert.equal(await casualOutfitTags("ベージュのニットに青いデニムスカート", convert), "beige sweater, blue denim skirt");
  assert.equal(calls, 1);
  assert.equal(await casualOutfitTags(undefined, convert), "");
  assert.equal(
    await casualOutfitTags("赤いワンピース", async () => {
      throw new Error("ollama down");
    }),
    "",
  );
  assert.equal(botOutfitSpec("casual", "").tags, BOT_TAN_OUTFITS.casual.tags);
  assert.equal(botOutfitSpec("casual", "red dress").tags, "red dress");
});
