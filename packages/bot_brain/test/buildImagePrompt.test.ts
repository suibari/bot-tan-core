import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImagePrompt,
  buildMossImagePrompt,
  normalizeScenePlan,
  sceneSystemFor,
  writableWords,
  type ImageScenePlan,
} from "../src/ai/buildImagePrompt.js";
import type { ResolvedCharacter } from "../src/ai/characterLookup.js";

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
    characters: [],
    botTan: true,
    ...overrides,
  };
}

const shimakaze: ResolvedCharacter = {
  request: { name: "島風", series: "艦これ" },
  tag: "shimakaze (kancolle)",
  series: "kantai collection",
  countTag: "1girl",
  appearance: ["blonde hair", "long hair", "black hairband", "striped thighhighs"],
  postCount: 20724,
};

const tanjirou: ResolvedCharacter = {
  request: { name: "竈門炭治郎", series: "鬼滅の刃" },
  tag: "kamado tanjirou",
  series: "kimetsu no yaiba",
  countTag: "1boy",
  appearance: ["haori", "earrings", "scar on forehead"],
  postCount: 30000,
};

test("キャラの外見タグはコード側が必ず連結する", () => {
  const built = buildImagePrompt(plan(), "suibari");
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
  const built = buildImagePrompt(plan(), "suibari");
  assert.ok(built);
  assert.doesNotMatch(built.prompt, /cloud hair ornament/);
});

test("suibari は合図の語を先頭に置き、画風の LoRA を当てる", () => {
  const built = buildImagePrompt(plan(), "suibari");
  assert.ok(built);
  assert.match(built.prompt, /^suibari style, 1girl, solo,/);
  assert.match(built.prompt, /masterpiece, high score, great score$/);
  // 画風と LoRA は不可分。LoRA が外れると画風が出ない。
  assert.deepEqual(built.loras, [["suibari-style-v1.safetensors", 0.5]]);
});

test("anime はスコアタグを反転しない", () => {
  const built = buildImagePrompt(plan(), "anime");
  assert.ok(built);
  assert.match(built.prompt, /masterpiece, high score, great score, absurdres/);
  assert.deepEqual(built.loras, []);
});

test("1キャラなら領域を割らず縦長", () => {
  const built = buildImagePrompt(plan(), "suibari");
  assert.ok(built);
  assert.equal(built.regions.length, 0);
  assert.match(built.prompt, /1girl, solo/);
  assert.equal(built.width, 832);
  assert.equal(built.height, 1216);
});

test("ラテちゃんが居るときは領域を割り、横長にする", () => {
  const built = buildImagePrompt(plan({ companions: ["latte-chan"] }), "suibari");
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

test("1人の絵では2人目を呼ぶタグを落とし、人数のネガティブを足す", () => {
  // 2026-09-26 8:48 の Nagi 投稿のシーン。このまま描くと botたんが2人並ぶ（分身）。
  const built = buildImagePrompt(
    plan({
      pose: ["sitting", "side by side"],
      expression: ["smile", "moved"],
      action: ["sharing emotion", "watching anime", "hand on shoulder"],
      setting: ["indoors", "dim lighting"],
      objects: ["screen"],
    }),
    "suibari",
  );
  assert.ok(built);
  assert.doesNotMatch(built.prompt, /side by side|sharing emotion|hand on shoulder/);
  assert.match(built.prompt, /watching anime/);
  assert.match(built.negativePrompt, /multiple girls, 2girls/);
});

test("1人の絵では鏡と相手のいない抱きつきも落とし、物や犬が相手なら残す", () => {
  const built = buildImagePrompt(
    plan({
      pose: ["standing", "hugging", "leaning on pet"],
      action: ["looking at mirror", "hugging plushie", "talking"],
      objects: ["mirror", "plushie"],
    }),
    "suibari",
  );
  assert.ok(built);
  const tags = built.prompt.split(", ");
  assert.ok(!tags.includes("hugging"));
  assert.ok(!tags.includes("looking at mirror"));
  assert.ok(!tags.includes("mirror"));
  assert.ok(tags.includes("hugging plushie"));
  assert.ok(tags.includes("leaning on pet"));
  // 話す相手は描かれず1人のままだった（4シード）ので残す。
  assert.ok(tags.includes("talking"));
});

test("自分の手を合わせる姿勢は1人の絵でも残す", () => {
  const built = buildImagePrompt(plan({ pose: ["sitting", "hands together"] }), "suibari");
  assert.ok(built);
  assert.match(built.prompt, /hands together/);
});

test("2人の絵では向かい合うタグを残し、領域に全体の人数タグを入れない", () => {
  const built = buildImagePrompt(
    plan({ pose: ["sitting", "facing each other"], companions: ["latte-chan"] }),
    "suibari",
  );
  assert.ok(built);
  assert.match(built.prompt, /facing each other/);
  assert.match(built.prompt, /2girls/);
  // 領域に 2girls が入ると、半分の領域の中で2人を描けと言うことになる。
  for (const region of built.regions) {
    assert.doesNotMatch(region.prompt, /2girls/);
    assert.match(region.prompt, /^1girl, /);
    assert.match(region.prompt, /facing each other/);
  }
  assert.doesNotMatch(built.negativePrompt, /multiple girls/);
});

test("2人目を呼ぶタグを落として薄くなったシーンは描かない", () => {
  const built = buildImagePrompt(
    plan({ pose: ["side by side"], expression: ["smile"], action: ["comforting"], setting: ["indoors"], objects: [] }),
    "suibari",
  );
  assert.equal(built, null);
});

test("ことみちゃんが居るときも領域を割り、外見が混ざらない", () => {
  const built = buildImagePrompt(plan({ companions: ["kotomi-chan"] }), "suibari");
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
    "suibari",
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
    "suibari",
  );
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  // 犬は 1girl と競合しないので、領域ではなく全体プロンプトに乗る。
  assert.match(built.prompt, /samoyed/);
});

test("モルフォは領域を割らない（1girl と競合しないので混線しない）", () => {
  const built = buildImagePrompt(plan({ companions: ["morpho"] }), "suibari");
  assert.ok(built);
  assert.equal(built.regions.length, 0);
  assert.match(built.prompt, /samoyed/);
  assert.match(built.prompt, /1girl, solo/);
});

test("屋外なら背景タグを足す（無いと空や単色へ逃げる）", () => {
  for (const style of ["suibari", "anime"] as const) {
    const built = buildImagePrompt(plan({ outdoor: true }), style);
    assert.ok(built);
    assert.match(built.prompt, /scenery, detailed background/);
  }
});

test("構図タグに姿勢語を混ぜない", () => {
  // standing を混ぜると「床から立てない」が「立っている」に化ける。
  const built = buildImagePrompt(plan({ pose: ["lying down", "on floor"] }), "suibari");
  assert.ok(built);
  assert.match(built.prompt, /lying down, on floor/);
  assert.doesNotMatch(built.prompt, /\bstanding\b/);
});

test("シーンが薄すぎるときは描かない", () => {
  // 空のまま描かせると、キャラ固定タグだけの同じプロンプトになり同じ絵が量産される。
  const built = buildImagePrompt(
    plan({ pose: [], expression: [], action: ["smile"], setting: [], objects: [] }),
    "suibari",
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
  assert.equal(buildImagePrompt(plan, "suibari"), null);
});

test("寝具はネガティブでも追い出す。ただし closed eyes は入れない", () => {
  for (const style of ["suibari", "anime"] as const) {
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

test("お絵描きの材料には就寝の規則を当てず、既存キャラの名前を原文のまま出させる", () => {
  const goodNight = sceneSystemFor("good-night");
  const picture = sceneSystemFor("picture");
  assert.match(goodNight, /bedtime greeting/);
  assert.doesNotMatch(picture, /bedtime greeting written at the end of the day/);
  // キャラ指名が無ければ従来どおり botたんを入れる。
  assert.match(picture, /When characters is empty, bot-tan always appears/);
  // タグは Danbooru で解決するので、名前は翻訳・ローマ字化させない（other_names で引く）。
  assert.match(picture, /Do not translate or romanize it/);
  assert.doesNotMatch(goodNight, /characters:/);
  // 語り手の「わたし」を『人類は衰退しました』の主人公へ解決させない。作品名付きなら拾う。
  assert.match(picture, /pronoun \(わたし[^)]*\) used by the writer is NOT a character name/);
  assert.match(picture, /人類は衰退しましたのわたし/);
  // 外見・名前を書かせない規則はどちらにも効く（キャラ崩れと領域割りの破綻を防ぐ）。
  for (const system of [goodNight, picture]) {
    assert.match(system, /NEVER describe the character's appearance/);
  }
});

test("描いてはいけないタグはどの材料でも落とす", () => {
  const plan = normalizeScenePlan({
    pose: ["sitting"],
    expression: ["smile", "blood on face"],
    action: ["holding cat"],
    setting: ["indoors"],
    objects: ["cat", "underwear", "nsfw"],
    companions: [],
    framing: "upper-body",
    outdoor: false,
  });
  assert.deepEqual(plan.expression, ["smile"]);
  assert.deepEqual(plan.objects, ["cat"]);
});

test("既存キャラを頼まれたら botたんではなくそのキャラを描く", () => {
  const built = buildImagePrompt(plan({ botTan: false }), "suibari", [shimakaze]);
  assert.ok(built);
  assert.equal(built.regions.length, 0);
  assert.match(built.prompt, /1girl, solo, shimakaze \(kancolle\), kantai collection, blonde hair/);
  assert.doesNotMatch(built.prompt, /light blue hair/);
  // キャラタグは学習元の露出傾向ごと呼ぶので、キャラのときだけネガティブを足す。
  assert.match(built.negativePrompt, /panties/);
  assert.equal(built.width, 832);
});

test("botたんの絵には既存キャラ用のネガティブを足さない（PoC で詰めた値のまま）", () => {
  const built = buildImagePrompt(plan(), "suibari");
  assert.ok(built);
  assert.doesNotMatch(built.negativePrompt, /panties/);
});

test("キャラを解決できなければ botTan=false でも botたんの絵に戻す", () => {
  const built = buildImagePrompt(
    plan({ botTan: false, characters: [{ name: "謎のキャラ", series: "" }] }),
    "suibari",
    [],
  );
  assert.ok(built);
  assert.match(built.prompt, /light blue hair/);
});

test("botたんと既存キャラの2人は領域を割り、キャラを先に置く", () => {
  const built = buildImagePrompt(plan(), "suibari", [shimakaze]);
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.match(built.prompt, /2girls/);
  assert.doesNotMatch(built.prompt, /shimakaze|light blue hair/);
  assert.match(built.regions[0].prompt, /^1girl, shimakaze \(kancolle\)/);
  assert.doesNotMatch(built.regions[0].prompt, /light blue hair/);
  assert.match(built.regions[1].prompt, /light blue hair/);
  assert.doesNotMatch(built.regions[1].prompt, /shimakaze/);
});

test("男の子のキャラは 1boy で数える", () => {
  const solo = buildImagePrompt(plan({ botTan: false }), "suibari", [tanjirou]);
  assert.ok(solo);
  assert.match(solo.prompt, /1boy, solo, kamado tanjirou/);

  const pair = buildImagePrompt(plan({ botTan: false }), "suibari", [shimakaze, tanjirou]);
  assert.ok(pair);
  assert.match(pair.prompt, /^suibari style, 1girl, 1boy,/);
  assert.match(pair.regions[1].prompt, /^1boy, kamado tanjirou/);
});

test("人物は2人で止める（キャラ2人 + botたんなら botたんが落ちる）", () => {
  const built = buildImagePrompt(plan({ botTan: true }), "suibari", [shimakaze, tanjirou]);
  assert.ok(built);
  assert.equal(built.regions.length, 2);
  assert.doesNotMatch(built.regions.map((region) => region.prompt).join("\n"), /light blue hair/);
});

test("キャラ指名を検査する（botたんたち自身・重複・空は落とし、botTan は指名があるときだけ外せる）", () => {
  const parsed = normalizeScenePlan({
    ...plan(),
    characters: [
      { name: "島風", series: "艦これ" },
      { name: "botたん", series: "" },
      { name: "島風", series: "艦これ" },
      { name: " ", series: "" },
      { name: "雪風", series: "艦これ" },
      { name: "天津風", series: "艦これ" },
    ],
    bot_tan: false,
  });
  assert.deepEqual(parsed.characters, [
    { name: "島風", series: "艦これ" },
    { name: "雪風", series: "艦これ" },
  ]);
  assert.equal(parsed.botTan, false);

  // 指名が無いのに bot_tan=false と言われても、誰も描かない絵にはしない。
  assert.equal(normalizeScenePlan({ ...plan(), characters: [], bot_tan: false }).botTan, true);
  // おやすみの絵のスキーマには characters が無い。
  assert.deepEqual(normalizeScenePlan({ ...plan(), characters: undefined }).characters, []);
});

test("名前だけの依頼でシーンが空なら、既存キャラは立ち絵で描く（botたんは描かないまま）", () => {
  const empty = { pose: [], expression: [], action: [], setting: [], objects: [] };
  const built = buildImagePrompt(plan({ ...empty, botTan: false }), "suibari", [shimakaze]);
  assert.ok(built);
  assert.match(built.prompt, /shimakaze \(kancolle\).*standing, smile, waving/);
  // キャラが解決できていなければ、従来どおり同じ絵の量産を防ぐ。
  assert.equal(buildImagePrompt(plan({ ...empty, botTan: false }), "suibari", []), null);
});


// ---------------------------------------------------------------------------
// MOSS-Image
// ---------------------------------------------------------------------------

const prose = {
  sentence: "Bot-tan is sipping cocoa at her desk.",
  props: ["A mug of cocoa is in her hands."],
  background: "Her cozy room with furniture in the background.",
  text: "",
};


test("MOSS: 合図の文 → 場面 → 小物 → 背景 → 構図 → 人物の順で、領域は割らない", () => {
  const built = buildMossImagePrompt(plan({ prose }), "suibari");
  assert.ok(built);
  assert.ok(
    built.prompt.startsWith(
      "suibari style. A loose hand-drawn sketch with rough lines and simple flat colors. Bot-tan is sipping cocoa at her desk. A mug of cocoa is in her hands. " +
        "Her cozy room with furniture in the background. Upper-body view. The girl is Bot-tan,",
    ),
    built.prompt,
  );
  assert.deepEqual(built.regions, []);
  assert.equal(built.engine, "moss");
  assert.equal(built.checkpoint, "moss_image_sft_int8_convrot.safetensors");
  assert.deepEqual(built.loras, [["moss-suibari-v1-000006.safetensors", 1.0]]);
});

test("MOSS: 書く言葉を指定しない絵は、文字を書かせない", () => {
  const built = buildMossImagePrompt(
    plan({ prose: { ...prose, props: ["A sign that reads \"OPEN\" hangs on the door.", ...prose.props] } }),
    "suibari",
  );
  assert.ok(built);
  // gemma が勝手に書いた看板の文字は落とす（言葉の決まっていない文字は謎の文字になる）。
  assert.doesNotMatch(built.prompt, /OPEN/);
  assert.match(built.prompt, /A mug of cocoa is in her hands\./);
  assert.match(built.negativePrompt, /text, letters, writing, words/);
});

test("MOSS: 依頼文が頼んだ言葉は、依頼のときだけ書かせる", () => {
  const asked = {
    ...prose,
    props: ["She holds up a sign that clearly reads \"おはよう\".", "A tree with a sign that reads \"PARK\"."],
    text: "おはよう",
  };
  const requested = buildMossImagePrompt(plan({ prose: asked }), "suibari", [], { writing: "requested" });
  assert.ok(requested);
  assert.match(requested.prompt, /She holds up a sign that clearly reads "おはよう"\./);
  assert.doesNotMatch(requested.prompt, /PARK/);
  assert.doesNotMatch(requested.negativePrompt, /writing/);

  // 依頼でなければ（おやすみ・ひとりごと）、頼まれた言葉があっても書かせない。
  const unasked = buildMossImagePrompt(plan({ prose: asked }), "suibari");
  assert.ok(unasked);
  assert.doesNotMatch(unasked.prompt, /おはよう/);
  assert.match(unasked.negativePrompt, /writing/);

  // 言葉を書く小物を gemma が書き忘れたら、言葉だけでも書かせる。
  const missing = buildMossImagePrompt(plan({ prose: { ...prose, text: "おはよう" } }), "suibari", [], {
    writing: "requested",
  });
  assert.match(missing!.prompt, /The words "おはよう" are clearly written in the picture\./);
});

test("MOSS: 呼び出し側が決めた言葉は、その文で書かせる", () => {
  const sentence = 'Bot-tan holds out a handwritten letter with both hands, and the letter clearly reads "すいばりさんへ".';
  const built = buildMossImagePrompt(plan({ prose }), "suibari", [], { writing: { words: "すいばりさんへ", sentence } });
  assert.ok(built);
  assert.ok(built.prompt.includes(`A mug of cocoa is in her hands. ${sentence} Her cozy room`), built.prompt);
  assert.doesNotMatch(built.negativePrompt, /writing/);
});

test("MOSS: 靴は全身の構図のときだけ書く（上半身で書くと靴が宙に浮く）", () => {
  const upper = buildMossImagePrompt(plan({ prose }), "suibari");
  const full = buildMossImagePrompt(plan({ prose, framing: "full-body" }), "suibari");
  assert.ok(upper && full);
  assert.doesNotMatch(upper.prompt, /loafers/);
  assert.match(full.prompt, /with white socks and brown loafers/);
});

test("MOSS: 服の種類と予定表の私服を文にする", () => {
  const pajamas = buildMossImagePrompt(plan({ prose }), "anime", [], { outfit: { kind: "pajamas" } });
  assert.match(pajamas!.prompt, /Bot-tan wears light-blue long-sleeved pajamas with long pants\./);
  const casual = buildMossImagePrompt(plan({ prose }), "anime", [], {
    outfit: { kind: "casual", casualTags: "white dress, sandals" },
  });
  assert.match(casual!.prompt, /Bot-tan wears white dress, sandals\./);
});

test("MOSS: 仲間の女の子もモルフォも同じ1本の文に書き、横長にする", () => {
  const built = buildMossImagePrompt(
    plan({ prose: { ...prose, sentence: "Bot-tan and Latte-chan share a parfait." }, companions: ["latte-chan", "morpho"] }),
    "suibari",
  );
  assert.ok(built);
  assert.match(built.prompt, /With her is Latte-chan, another girl with very long pink hair/);
  assert.match(built.prompt, /With her is Morpho, her big fluffy white Samoyed dog\./);
  assert.deepEqual([built.width, built.height], [1216, 832]);
});

test("MOSS: 描かない仲間の名前が文にあれば、タグ列から言い直す", () => {
  const built = buildMossImagePrompt(
    plan({ prose: { ...prose, sentence: "Bot-tan chats with Kotomi-chan." } }),
    "suibari",
  );
  assert.ok(built);
  assert.doesNotMatch(built.prompt, /Kotomi-chan/);
  assert.match(built.prompt, /Bot-tan, sitting, smile, holding cup, indoors, night, mug\./);
});

test("MOSS: 既存キャラは名前・作品・Danbooru の外見で書く", () => {
  const built = buildMossImagePrompt(
    plan({ prose: { ...prose, sentence: "Shimakaze is waving on a pier." }, botTan: false }),
    "anime",
    [shimakaze],
  );
  assert.ok(built);
  assert.match(
    built.prompt,
    /The girl is Shimakaze from Kantai Collection, with blonde hair, long hair, black hairband, striped thighhighs\./,
  );
  assert.doesNotMatch(built.prompt, /Bot-tan/);
});

test("MOSS: シーンが薄ければ SDXL と同じく描かない", () => {
  assert.equal(
    buildMossImagePrompt(plan({ pose: [], expression: [], action: [], setting: ["indoors"], objects: [], prose }), "anime"),
    null,
  );
});

test("英文にもタグと同じ禁止を当てる（寝具の文は丸ごと落とす）", () => {
  const normalized = normalizeScenePlan({
    pose: ["sitting"], expression: ["smile"], action: ["reading book"], setting: ["indoors"], objects: ["book"],
    companions: [], framing: "upper-body", outdoor: false,
    sentence: "Bot-tan is reading a book in bed",
    props: ["A book is open on her lap", "A pillow lies beside her."],
    background: "A quiet library in the background",
    text: "",
  });
  assert.deepEqual(normalized.prose, {
    sentence: "",
    props: ["A book is open on her lap."],
    background: "A quiet library in the background.",
    text: "",
  });
});

test("絵に書かせる言葉は、引用符と絵文字を外し、長すぎれば書かせない", () => {
  const prose = (text: string) =>
    normalizeScenePlan({ pose: ["sitting"], companions: [], framing: "upper-body", outdoor: false, sentence: "x", text })
      .prose?.text;
  assert.equal(prose("「おはよう」🌞"), "おはよう");
  assert.equal(prose("Happy Birthday!"), "Happy Birthday!");
  assert.equal(prose("あ".repeat(21)), "");
  assert.equal(writableWords("  GOOD  NIGHT "), "GOOD NIGHT");
});

test("英文を書かせていない計画には prose を付けない", () => {
  const normalized = normalizeScenePlan({ pose: ["sitting"], companions: [], framing: "upper-body", outdoor: false });
  assert.equal(normalized.prose, undefined);
});
