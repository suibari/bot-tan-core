import { ollamaChat } from "../ollamaChat.js";

/**
 * botたんのイラスト生成プロンプトを組み立てる層。
 *
 * ## 何を LLM に出させ、何を出させないか
 * LLM に出させるのは **シーンだけ**（姿勢・表情・行為・場所・時間帯・小物・同伴者）。
 * キャラクターの外見はこのファイルの定数で、コード側が必ず前後に連結する。
 *
 * 材料になるのはおやすみポストの本文と、その日の行動履歴
 * （`ScheduledPostCoordinator.ts` の `buildGoodNightImage` が組み立てる）。本文だけを渡すと
 * 「これから就寝します」という枠が主題に見えて、毎日「夜・寝室・目を閉じた botたん」が
 * 出てくる。`SCENE_SYSTEM` 側でも枠が主題でないことを明示している。
 *
 * 理由は2つ。
 *  * 外見を毎回 LLM に書かせると語が揺れ、揺れがそのままキャラ崩れになる
 *  * 拡散モデルは1文の中で「どの属性がどのキャラのものか」を束縛できない。
 *    タグの出どころを1箇所に固定しておかないと、後述の領域プロンプトも組めない
 *
 * 凍結前の generateImage.ts がキャラ特徴をハードコードの英語プロンプトで持ち、
 * 末尾の Scene だけを差し替えていたのと同じ構造をそのまま保っている。
 *
 * ## 数値の出どころ
 * タグ・画風・サンプラ設定はすべて bot-tan-imagegen の PoC（2026-09-06）で実測して
 * 決めたもの。根拠は同リポジトリの RESULTS.md にある。ここを勘で書き換えると、
 * 「背景が出ない」「素人の絵にならない」といった形で静かに劣化する。
 */

// ---------------------------------------------------------------------------
// キャラクター
// ---------------------------------------------------------------------------

type Character = { core: string; outfit: string; accessory: string };

/**
 * 設定画（img/bot-tan-concept.png）から起こしたタグ。
 *
 * **`cloud hair ornament` は入れない。** 設定画には雲のヘアピンがあるが、タグにすると
 * 髪飾りではなく **背景に雲を生やす**。公園も夕焼けも空と雲の絵に化けた（外したら直る
 * ことを同一シードで確認）。蝶だけに絞る。
 *
 * 人数タグ（1girl / 2girls）は core に入れない。呼び出し側が人数を決めるので、
 * 入れると 1girl が二重になる。
 */
const BOT_TAN: Character = {
  // `sidelocks` と `hair between eyes` は設定画の「サイドバング」。顔の左右を長い横髪が
  // 縁取り、前髪の一部が目の間へ落ちる形で、これが無いと横髪の情報を持たない絵が出る。
  // 設定画の「レイヤーカット」は入れない。`wolf cut` は新しめのタグで Animagine XL 4.0
  // での効きが未検証、外すと髪型ごと崩れる。上の2つで足りるかを先に見る。
  core:
    "light blue hair, very long hair, sidelocks, hair between eyes, ahoge, " +
    "thick eyebrows, jitome, half-closed eyes, blue eyes",
  outfit:
    "school uniform, mint green sweater, long sleeves, white collared shirt, blue neck ribbon, blue pleated skirt, white socks, brown loafers",
  accessory: "butterfly hair ornament",
};

/** 設定画には「天」の漢字が入った赤ヘアピンがあるが、拡散モデルに漢字は描けない。狙わない。 */
const LATTE_CHAN: Character = {
  core: "pink hair, very long hair, cat ears, cat tail, white tail, green eyes",
  outfit: "maid, maid headdress, maid apron",
  accessory: "red ribbon, red hair ornament",
};

/**
 * 設定画（bot-tan-com の src/assets/characters/kotomi.png）から起こしたタグ。
 *
 * 衣装は設定画の私服＝アイドル衣装で固定する。ラテちゃんがシーンによらずメイド服なのと
 * 同じ「署名的な1着」の作法で、制服にすると botたんとの差が髪色だけになり、領域を割っても
 * 2人の見分けが弱くなる。
 *
 * **メンダコのヒレ耳とタコ目は入れない。** `tentacle` 系のタグは booru 空間で意味が汚れて
 * いて狙うと事故る（`head fins` も安定しない）。横長の瞳孔も `rectangular pupils` の効きが
 * 薄い。必要になったら `slit pupils` を同一シードで比較してから足すこと。
 * 赤いメンダコのぬいぐるみはシーン依存の小物なので、固定の accessory には置かない。
 */
const KOTOMI_CHAN: Character = {
  core: "orange hair, short hair, ahoge, green eyes, freckles",
  outfit:
    "pink shirt, puffy short sleeves, frilled sleeves, black skirt, frilled skirt, black footwear",
  accessory: "red bow, corset",
};

/** サモエド犬。1girl と競合しないのでキャラ混線を起こさない（領域も割らない）。 */
const MORPHO_TAGS = "samoyed, white dog, dog";

const CHARACTERS = {
  "bot-tan": BOT_TAN,
  "latte-chan": LATTE_CHAN,
  "kotomi-chan": KOTOMI_CHAN,
} as const;

export type ImageCompanion = "morpho" | "latte-chan" | "kotomi-chan";

/** 領域を割る必要がある同伴者（＝女の子）。モルフォは犬なので入らない。 */
const GIRL_COMPANIONS = ["latte-chan", "kotomi-chan"] as const;

/** LLM が返した companions を検証するための集合。SCENE_SCHEMA の enum と揃えること。 */
const COMPANION_NAMES: ReadonlySet<string> = new Set<ImageCompanion>([
  "morpho",
  ...GIRL_COMPANIONS,
]);

// ---------------------------------------------------------------------------
// 画風
// ---------------------------------------------------------------------------

const BASE_NEGATIVE =
  "lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, " +
  "cropped, worst quality, low quality, signature, watermark, username, blurry";

/**
 * 頭身が低くなる（頭が大きくデフォルメ寄りになる）のを止める。
 * 凍結前の Gemini プロンプトが `Be careful not to lose balance between the body and face`
 * と書いていた懸念が、ローカルでもそのまま出た。拡散モデルにその手の指示は効かないので
 * ネガティブで殴るのが一番効いた。
 */
const CHIBI_NEGATIVE = "chibi, deformed, sd character, child, big head";

/**
 * 寝具を画面から追い出す。**正のタグを落とすだけでは足りない。**
 * 材料がおやすみポスト本文である以上、`indoors, night` だけでもベッドのある部屋へ寄る。
 *
 * `closed eyes` はここへ入れない。botたんの署名である `jitome, half-closed eyes` と
 * 綱引きになり、目つきごと変わる。閉じた目は正のタグから落とすだけにとどめる
 * （`SLEEP_PATTERN`）。
 */
const SLEEP_NEGATIVE =
  "sleeping, bed, on bed, pillow, blanket, futon, pajamas, nightgown, zzz";

/** 画材が「小道具として絵の中に描かれる」のを止める。これが無いと床にクレヨンが転がる。 */
const ART_PROP_NEGATIVE =
  "sketchbook, art tools, crayon, pencil, colored pencil, frame, picture frame, canvas, easel";

export type ImageStyle = "crayon-diary" | "anime";

type StyleSpec = {
  /** プロンプトの先頭に置くか。クレヨンは先頭に置かないとベースモデルの絵柄に負ける。 */
  leading?: string;
  /** 末尾に置く品質タグ。 */
  quality: string;
  negative: string;
  /** 屋外でも背景タグを足さない。 */
  skipScenery?: boolean;
  /**
   * この画風に不可欠な LoRA（サイドカーの models/loras/ にあるファイル名）。
   * **画風と画材は不可分**なので、env ではなくここに置く。クレヨンのプロンプトだけ投げて
   * LoRA を当て忘れると、質感の出ない中途半端な絵が黙って出てくる。
   */
  loras?: Array<[string, number]>;
};

const STYLES: Record<ImageStyle, StyleSpec> = {
  /**
   * 「botたんが描いた日記」。3つの組み合わせで初めて成立する。
   *  1. 画材タグを Danbooru の medium 形（`crayon (medium)`）にする。
   *     `crayon drawing` や `sketchbook` と書くと小道具として絵の中に描かれる
   *  2. **score タグを反転する。** Animagine は score タグで絵の巧さを直接操作できる設計で、
   *     `masterpiece, high score` を入れている限り素人の絵にならない。ネガティブへ回し、
   *     正には `average score` を置く。`low score, bad score` まで振ると顔が崩れた
   *  3. クレヨン LoRA を当てる（サイドカー側が持つ）。ワックスのストローク・紙目・
   *     ムラのある塗りは、ベースモデル単体では絶対に出ない
   */
  "crayon-diary": {
    leading: "child's drawing, crayon (medium), traditional media",
    quality: "average score",
    negative:
      `${BASE_NEGATIVE}, ${CHIBI_NEGATIVE}, ${ART_PROP_NEGATIVE}, ${SLEEP_NEGATIVE}, ` +
      "realistic, photorealistic, 3d, anime screencap, digital painting, " +
      "depth of field, bokeh, film grain, glowing, sparkle, " +
      "masterpiece, high score, great score",
    skipScenery: true,
    // ostris/Crayon Style - SDXL。トリガーワード無し、weight 1.0 が作者推奨。
    // ライセンスは生成画像の商用利用可・サービスホスト可・モデル販売は不可。
    loras: [["crayons_v1_sdxl.safetensors", 1.0]],
  },
  /** 通常のアニメ塗り。切り戻し用に残してある。 */
  anime: {
    quality: "masterpiece, high score, great score, absurdres",
    negative: `${BASE_NEGATIVE}, low score, bad score, average score, ${CHIBI_NEGATIVE}, ${SLEEP_NEGATIVE}`,
  },
};

/** 屋外は背景タグを足さないと空や単色へ逃げる。 */
const SCENERY_TAGS = "scenery, detailed background";

// ---------------------------------------------------------------------------
// LLM が起こすシーン
// ---------------------------------------------------------------------------

export type ImageScenePlan = {
  pose: string[];
  expression: string[];
  action: string[];
  setting: string[];
  objects: string[];
  /** 列挙。自由文にさせない（外見記述の混入と、領域割りの破綻を防ぐ）。 */
  companions: ImageCompanion[];
  framing: "upper-body" | "full-body";
  outdoor: boolean;
};

const SCENE_SCHEMA = {
  type: "object",
  properties: {
    pose: { type: "array", items: { type: "string" } },
    expression: { type: "array", items: { type: "string" } },
    action: { type: "array", items: { type: "string" } },
    setting: { type: "array", items: { type: "string" } },
    objects: { type: "array", items: { type: "string" } },
    companions: {
      type: "array",
      items: { type: "string", enum: ["morpho", "latte-chan", "kotomi-chan"] },
    },
    framing: { type: "string", enum: ["upper-body", "full-body"] },
    outdoor: { type: "boolean" },
  },
  required: ["pose", "expression", "action", "setting", "objects", "companions", "framing", "outdoor"],
};

const SCENE_SYSTEM = `You turn a Japanese description of an anime character's day into Danbooru-style English tags for an anime image generator.

Rules:
* Output ONLY lowercase Danbooru tags, 1-3 words each.
* NEVER describe the character's appearance (hair color, hair length, eyebrows, eye shape, clothing, accessories). Those are fixed elsewhere. Describing them corrupts the character.
* NEVER output character names, series names, real people, or the tags "text", "watermark", "signature".
* pose: body posture. e.g. lying down, on back, sitting, kneeling, arms up, leaning forward
* expression: face only. e.g. smile, open mouth, blush, closed eyes, surprised
* action: what she is doing. e.g. watching television, holding cup, running, reading book
* setting: place, time of day, weather. e.g. indoors, bedroom, night, on floor, outdoors, park, sunset, rain
* objects: props visible in the scene. e.g. television, mug, bento, notebook, umbrella
* companions: "morpho" only if a white Samoyed dog is present, "latte-chan" only if the pink-haired cat-eared maid friend is present, "kotomi-chan" only if the orange-haired short-haired classmate is present. Empty otherwise.
* framing: "full-body" if the whole body and the place matter, "upper-body" for a close moment.
* outdoor: true only if the scene is outside.
* Prefer 2-5 tags per field. Use an empty array if nothing applies.
* Posture tags matter most: if she is on the floor, say so.
* The text is a bedtime greeting written at the end of the day. Going to bed, falling asleep and the greeting itself are NEVER the subject. Draw a moment from the day it recalls.
* When the text tells a dream, draw what happens INSIDE the dream as a real scene: she is awake and doing it, eyes open. Do not draw her sleeping while she dreams it.
* NEVER output these tags, whatever the text says: sleeping, asleep, sleepy, closed eyes, bed, bedroom, pillow, blanket, futon, pajamas, zzz.
* Pick the single most vivid moment. Do not try to describe the whole day.`;

const FORBIDDEN = new Set(["text", "watermark", "signature", "username"]);

/**
 * 就寝そのものへ引き戻すタグ。**指示だけに任せず、ここで必ず落とす。**
 *
 * 材料になるのは「これから寝る」という枠で書かれたおやすみポスト本文なので、
 * `SCENE_SYSTEM` でいくら禁じても寝具や閉じた目が繰り返し出てくる。2026-09-09 の
 * 本文で planImageScene を3回回したところ、3回とも `closed eyes` + `bedroom` が
 * 付いた（拾った場面は「机の掃除」だったのに、絵は寝ているところになる）。
 *
 * **`night` は落とさない。** 夜そのものは寝ている絵にはならず、落とすと夜の場面
 * （花火、夜ふかし）まで昼に化ける。落とすのは「画面にベッドと閉じた目が入る」タグだけ。
 * `bedroom` は booru では画面にベッドが入る意味なので落とす（`indoors` / `room` は残る）。
 *
 * 落とした結果タグが薄くなった日は `MIN_SCENE_TAGS` に引っかかって描かない。
 * 寝ている絵を出すより、その日は絵なしのほうがよい。
 */
const SLEEP_PATTERN =
  /\b(sleep|asleep|slumber|doze|dozing|nap|bed|pillow|blanket|duvet|quilt|futon|pajama|pyjama|nightgown|nightcap|nightwear|sleepwear|zzz|dreaming|closed eyes|eyes closed)/;

/**
 * 日本語の情景文からシーンのタグを起こす。
 *
 * 常駐している gemma を使う（`ollamaChat` は `think: false` を送るので、思考モデルでも
 * content が空にならない）。temperature を低くするのは、同じ文から毎回違うタグが出ると
 * 絵の当たり外れが情景ではなく変換のブレに支配されるため。0 にはしない。
 */
export async function planImageScene(sourceText: string): Promise<ImageScenePlan | null> {
  const raw = await ollamaChat(
    "BSKY_IMAGE_PROMPT",
    [
      { role: "system", content: SCENE_SYSTEM },
      { role: "user", content: sourceText },
    ],
    { maxTokens: 400, temperature: 0.2, timeoutMs: 120_000, format: SCENE_SCHEMA },
  );
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[WARN][IMGGEN] シーン変換の JSON が壊れていた:", raw.slice(0, 200));
    return null;
  }
  return normalizeScenePlan(parsed);
}

/**
 * LLM が返した JSON をシーン計画にする。**検査はここに集約する。**
 *
 * planImageScene から切り出してあるのは、Ollama を起こさずにこの層だけをテストするため。
 * 落としたタグは黙って消さずに1行残す（どの規則が効いたのかは本番ログでしか分からない）。
 */
export function normalizeScenePlan(parsed: unknown): ImageScenePlan {
  const value = (parsed ?? {}) as Partial<ImageScenePlan>;
  const dropped: string[] = [];
  const list = (input: unknown): string[] =>
    Array.isArray(input)
      ? input
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => tag.length > 0)
          .filter((tag) => {
            if (!FORBIDDEN.has(tag) && !SLEEP_PATTERN.test(tag)) return true;
            dropped.push(tag);
            return false;
          })
      : [];

  const plan: ImageScenePlan = {
    pose: list(value.pose),
    expression: list(value.expression),
    action: list(value.action),
    setting: list(value.setting),
    objects: list(value.objects),
    companions: list(value.companions).filter((name): name is ImageCompanion =>
      COMPANION_NAMES.has(name),
    ),
    framing: value.framing === "upper-body" ? "upper-body" : "full-body",
    outdoor: value.outdoor === true,
  };
  if (dropped.length > 0) {
    console.warn("[WARN][IMGGEN] 使えないタグを落とした:", dropped.join(", "));
  }
  return plan;
}

// ---------------------------------------------------------------------------
// プロンプト組み立て
// ---------------------------------------------------------------------------

export type ImageRegion = { prompt: string; x0: number; x1: number };

export type BuiltImagePrompt = {
  prompt: string;
  negativePrompt: string;
  /** 2キャラのときだけ入る。サイドカーが領域ごとに UNet を回す。 */
  regions: ImageRegion[];
  width: number;
  height: number;
  loras: Array<[string, number]>;
};

/** シーンのタグを1本に並べる。順序は設定 → 姿勢 → 表情 → 行為 → 小物。 */
function sceneTags(plan: ImageScenePlan): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...plan.pose, ...plan.expression, ...plan.action, ...plan.setting, ...plan.objects]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.join(", ");
}

/** シーンが薄すぎるときは描かせない。空のまま投げると同じ絵が量産される。 */
const MIN_SCENE_TAGS = 4;

/**
 * 1枚に描く女の子の上限。
 *
 * 予定表（dailyPlan.ts）は「ことみちゃん・ラテちゃん・モルフォ」の3人同伴の日を作るが、
 * 1場面に女の子3人が写る必然性は低い。左右2分割の領域を3分割すると 1216x832 では1人ぶんの
 * 幅が足りずキャラが崩れ、UNet の呼び出しも増えて生成時間が伸びる。
 */
const MAX_GIRLS = 2;

/**
 * シーン計画を実際のプロンプトにする。
 *
 * 2キャラ（botたん + ラテちゃん or ことみちゃん）のときは **領域プロンプト** を組む。
 * 1本のプロンプトに2キャラを詰めると属性が混ざり、ラテちゃんの猫耳とメイド服が
 * botたんにも生える。BREAK でチャンクを分けても、属性を減らしても、重み付けしても
 * 解消しなかった。別プロンプトで予測させて空間で混ぜる方式で初めて分離できた
 * （2シード×2画風で確認）。
 *
 * 2キャラは横長にする。縦長のまま左右に並べると窮屈になる。
 */
export function buildImagePrompt(plan: ImageScenePlan, style: ImageStyle): BuiltImagePrompt | null {
  const scene = sceneTags(plan);
  if (scene.split(",").filter((tag) => tag.trim()).length < MIN_SCENE_TAGS) {
    console.warn("[WARN][IMGGEN] シーンのタグが少なすぎるので描かない:", scene);
    return null;
  }

  const spec = STYLES[style];

  // 同伴の女の子は botたんと合わせて MAX_GIRLS 人まで。溢れたぶんは捨てる。
  // 順序は LLM が返したまま（先に挙げたほうがその場面で目立っていたはず）。
  const requestedGirls = plan.companions.filter((name): name is (typeof GIRL_COMPANIONS)[number] =>
    (GIRL_COMPANIONS as readonly string[]).includes(name),
  );
  const companionGirls = requestedGirls.slice(0, MAX_GIRLS - 1);
  if (companionGirls.length < requestedGirls.length) {
    console.warn(
      `[WARN][IMGGEN] 女の子は${MAX_GIRLS}人までなので同伴者を絞った:`,
      requestedGirls.join(", "),
      "->",
      companionGirls.join(", "),
    );
  }

  const girls: Array<keyof typeof CHARACTERS> = ["bot-tan", ...companionGirls];
  const count = girls.length === 1 ? "1girl, solo" : `${girls.length}girls`;

  const tail = [
    "safe",
    scene,
    ...(plan.outdoor && !spec.skipScenery ? [SCENERY_TAGS] : []),
    plan.framing === "upper-body" ? "upper body" : "full body",
    spec.quality,
  ];
  // 姿勢はシーン側が決める。standing のような姿勢語を構図タグに混ぜると、
  // 「床から立てない」が「立っている」に化ける。

  const head = [...(spec.leading ? [spec.leading] : []), count];
  const morpho = plan.companions.includes("morpho") ? [MORPHO_TAGS] : [];

  // 領域を割るときは全体プロンプトへ外見タグを入れない（入れると領域の意味が消える）。
  const splitRegions = girls.length > 1;

  const prompt = [
    ...head,
    ...(splitRegions ? [] : [BOT_TAN.core, BOT_TAN.outfit, BOT_TAN.accessory]),
    ...morpho,
    ...tail,
  ]
    .filter(Boolean)
    .join(", ");

  const regions: ImageRegion[] = [];
  if (splitRegions) {
    const spans: Array<[number, number]> = [
      [0.0, 0.55],
      [0.45, 1.0],
    ];
    girls.forEach((name, index) => {
      const character = CHARACTERS[name];
      const who = ["1girl", character.core, character.outfit, character.accessory].join(", ");
      regions.push({ prompt: `${who}, ${prompt}`, x0: spans[index][0], x1: spans[index][1] });
    });
  }

  return {
    prompt,
    negativePrompt: spec.negative,
    regions,
    // Animagine XL 4.0 のモデルカード記載の推奨解像度。
    width: splitRegions ? 1216 : 832,
    height: splitRegions ? 832 : 1216,
    loras: spec.loras ?? [],
  };
}

/** テストとデバッグ用。実プロンプトを組み立てずにタグだけ見たいとき。 */
export const IMAGE_PROMPT_INTERNALS = {
  BOT_TAN,
  LATTE_CHAN,
  KOTOMI_CHAN,
  MORPHO_TAGS,
  STYLES,
  SCENERY_TAGS,
};
