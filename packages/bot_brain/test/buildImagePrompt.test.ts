import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImagePrompt,
  normalizeScenePlan,
  type ImageScenePlan,
} from "../src/ai/buildImagePrompt.js";

function plan(overrides: Partial<ImageScenePlan> = {}): ImageScenePlan {
  return {
    pose: ["sitting"],
    expression: ["smile"],
    action: ["holding cup"],
    setting: ["indoors", "night"],
    objects: ["mug"],
    companions: [],
    framing: "upper-body",
    outdoor: false,
    ...overrides,
  };
}

test("キャラの外見タグはコード側が必ず連結する", () => {
  const built = buildImagePrompt(plan(), "crayon-diary");
  assert.ok(built);
  // 揺れると同一性が壊れるので、LLM ではなく定数から来ていることを固定する。
  assert.match(built.prompt, /light blue hair/);
  assert.match(built.prompt, /ahoge/);
  assert.match(built.prompt, /mint green sweater/);
  assert.match(built.prompt, /butterfly hair ornament/);
  // 設定画の「サイドバング」。無いと横髪の情報を持たない絵が出る。
  assert.match(built.prompt, /sidelocks/);
  assert.match(built.prompt, /hair between eyes/);
});

test("雲の髪飾りは入れない（背景に雲が湧く）", () => {
  const built = buildImagePrompt(plan(), "crayon-diary");
  assert.ok(built);
  assert.doesNotMatch(built.prompt, /cloud hair ornament/);
});

test("crayon-diary は score タグを反転する", () => {
  const built = buildImagePrompt(plan(), "crayon-diary");
  assert.ok(built);
  // masterpiece/high score が正に入っている限り素人の絵にならない。
  assert.match(built.prompt, /average score/);
  assert.doesNotMatch(built.prompt, /masterpiece/);
  assert.match(built.negativePrompt, /masterpiece, high score, great score/);
  // 画材を小道具として描かせないネガティブ。
  assert.match(built.negativePrompt, /sketchbook/);
  // 画風と画材は不可分。LoRA が外れると質感が出ない。
  assert.deepEqual(built.loras, [["crayons_v1_sdxl.safetensors", 1.0]]);
});

test("anime はスコアタグを反転しない", () => {
  const built = buildImagePrompt(plan(), "anime");
  assert.ok(built);
  assert.match(built.prompt, /masterpiece, high score, great score, absurdres/);
  assert.deepEqual(built.loras, []);
});

test("1キャラなら領域を割らず縦長", () => {
  const built = buildImagePrompt(plan(), "crayon-diary");
  assert.ok(built);
  assert.equal(built.regions.length, 0);
  assert.match(built.prompt, /1girl, solo/);
  assert.equal(built.width, 832);
  assert.equal(built.height, 1216);
});

test("ラテちゃんが居るときは領域を割り、横長にする", () => {
  const built = buildImagePrompt(plan({ companions: ["latte-chan"] }), "crayon-diary");
  assert.ok(built);
  // 1本のプロンプトに2キャラを詰めると属性が混ざる。別プロンプトで予測させて空間で混ぜる。
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  assert.equal(built.width, 1216);
  assert.equal(built.height, 832);

  // 全体プロンプトにはどちらのキャラの外見も入れない（入れると領域の意味が消える）。
  assert.doesNotMatch(built.prompt, /cat ears/);
  assert.doesNotMatch(built.prompt, /light blue hair/);
  // 領域はそれぞれ1人分だけを持つ。
  assert.match(built.regions[0].prompt, /light blue hair/);
  assert.doesNotMatch(built.regions[0].prompt, /cat ears/);
  assert.match(built.regions[1].prompt, /cat ears/);
  assert.doesNotMatch(built.regions[1].prompt, /light blue hair/);
  // 境界は少し重ねる（feather で継ぎ目をなだらかにする前提）。
  assert.ok(built.regions[0].x1 > built.regions[1].x0);
});

test("ことみちゃんが居るときも領域を割り、外見が混ざらない", () => {
  const built = buildImagePrompt(plan({ companions: ["kotomi-chan"] }), "crayon-diary");
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  assert.equal(built.width, 1216);
  assert.equal(built.height, 832);

  assert.doesNotMatch(built.prompt, /orange hair/);
  assert.doesNotMatch(built.prompt, /light blue hair/);
  assert.match(built.regions[0].prompt, /light blue hair/);
  assert.doesNotMatch(built.regions[0].prompt, /orange hair/);
  assert.match(built.regions[1].prompt, /orange hair/);
  assert.doesNotMatch(built.regions[1].prompt, /light blue hair/);
});

test("女の子は2人で止める（3人目は捨てる）", () => {
  // 予定表は3人同伴の日を作るが、1216x832 を3分割するとキャラが崩れる。
  const built = buildImagePrompt(
    plan({ companions: ["latte-chan", "kotomi-chan"] }),
    "crayon-diary",
  );
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  // 先に挙がったラテちゃんが残り、ことみちゃんは落ちる。
  assert.match(built.regions[1].prompt, /cat ears/);
  assert.doesNotMatch(built.regions[0].prompt + built.regions[1].prompt, /orange hair/);
});

test("モルフォとことみちゃんが同時でも、モルフォは領域を割らない", () => {
  const built = buildImagePrompt(
    plan({ companions: ["morpho", "kotomi-chan"] }),
    "crayon-diary",
  );
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  // 犬は 1girl と競合しないので、領域ではなく全体プロンプトに乗る。
  assert.match(built.prompt, /samoyed/);
});

test("モルフォは領域を割らない（1girl と競合しないので混線しない）", () => {
  const built = buildImagePrompt(plan({ companions: ["morpho"] }), "crayon-diary");
  assert.ok(built);
  assert.equal(built.regions.length, 0);
  assert.match(built.prompt, /samoyed/);
  assert.match(built.prompt, /1girl, solo/);
});

test("屋外でも crayon-diary は背景タグを足さない", () => {
  const built = buildImagePrompt(plan({ outdoor: true }), "crayon-diary");
  assert.ok(built);
  assert.doesNotMatch(built.prompt, /scenery/);
});

test("anime は屋外なら背景タグを足す（無いと空や単色へ逃げる）", () => {
  const built = buildImagePrompt(plan({ outdoor: true }), "anime");
  assert.ok(built);
  assert.match(built.prompt, /scenery, detailed background/);
});

test("構図タグに姿勢語を混ぜない", () => {
  // standing を混ぜると「床から立てない」が「立っている」に化ける。
  const built = buildImagePrompt(plan({ pose: ["lying down", "on floor"] }), "crayon-diary");
  assert.ok(built);
  assert.match(built.prompt, /lying down, on floor/);
  assert.doesNotMatch(built.prompt, /\bstanding\b/);
});

test("シーンが薄すぎるときは描かない", () => {
  // 空のまま描かせると、キャラ固定タグだけの同じプロンプトになり同じ絵が量産される。
  const built = buildImagePrompt(
    plan({ pose: [], expression: [], action: ["smile"], setting: [], objects: [] }),
    "crayon-diary",
  );
  assert.equal(built, null);
});

test("就寝そのもののタグは落とす（材料が「これから寝る」本文なので必ず出てくる）", () => {
  const plan = normalizeScenePlan({
    pose: ["lying down", "on bed"],
    expression: ["smile", "closed eyes"],
    action: ["cleaning", "sleeping"],
    setting: ["indoors", "bedroom", "night"],
    objects: ["desk", "pillow", "blanket"],
    companions: [],
    framing: "upper-body",
    outdoor: false,
  });
  assert.deepEqual(plan.pose, ["lying down"]);
  assert.deepEqual(plan.expression, ["smile"]);
  assert.deepEqual(plan.action, ["cleaning"]);
  // night は残す。夜そのものは寝ている絵にならず、落とすと夜の場面が昼に化ける。
  assert.deepEqual(plan.setting, ["indoors", "night"]);
  assert.deepEqual(plan.objects, ["desk"]);
});

test("落とした結果タグが薄くなったら描かない（寝ている絵より絵なし）", () => {
  const plan = normalizeScenePlan({
    pose: ["lying down"],
    expression: ["closed eyes"],
    action: ["sleeping"],
    setting: ["bedroom", "night"],
    objects: ["pillow", "blanket"],
    companions: [],
    framing: "upper-body",
    outdoor: false,
  });
  assert.equal(buildImagePrompt(plan, "crayon-diary"), null);
});

test("寝具はネガティブでも追い出す。ただし closed eyes は入れない", () => {
  for (const style of ["crayon-diary", "anime"] as const) {
    const built = buildImagePrompt(plan(), style);
    assert.ok(built);
    assert.match(built.negativePrompt, /sleeping, bed, on bed, pillow, blanket/);
    // botたんの署名である jitome, half-closed eyes と綱引きになるので入れない。
    assert.doesNotMatch(built.negativePrompt, /closed eyes/);
  }
});

test("既定タグは通す（過剰にマッチして場面ごと消さない）", () => {
  const kept = normalizeScenePlan({
    pose: ["sitting", "kneeling"],
    expression: ["smile", "blush"],
    action: ["reading book", "holding cup"],
    setting: ["outdoors", "park", "sunset", "night"],
    objects: ["notebook", "mug", "bench"],
    companions: ["morpho"],
    framing: "full-body",
    outdoor: true,
  });
  assert.equal(kept.setting.length, 4);
  assert.equal(kept.objects.length, 3);
  assert.deepEqual(kept.companions, ["morpho"]);
});
