/**
 * 絵文字生成の入力検証とプロンプト組み立て。docs/emoji-generation.md。
 *
 * 本人はプロンプトを1つ書くだけ（文字かイラストかのモードは選ばせない）。受付時に gemma が
 * 「何を描くか（英文）」「書く文字」「縦横比」に分け、ここで画風・背景・構図を固定した
 * MOSS 向けの文に組む。入力で背景や画風を書き換えられると、クロマキー抜き（imggen の cutout）が
 * 破綻するので、本人の言葉は「何を描くか」と「書く文字」にだけ入る。
 * 解釈がずれても、botたんが描くものなのでご愛敬とする。
 * config を読まない純粋な関数だけを置く（テストで環境変数を要らなくするため）。
 */
import {
  MOSS_CHARACTERS,
  MOSS_MORPHO,
  mossCharacterProse,
  type MossCharacter,
  type MossOutfitKind,
} from "@bsky-affirmative-bot/shared-configs";
import { ApiError } from "../middleware/errors.js";

/** square は 1:1、wide は 2:1、long は約3:1、xlong は4:1。 */
export type EmojiAspect = "square" | "wide" | "long" | "xlong";
export type ChromaKey = "magenta" | "green";

export const EMOJI_PROMPT_MAX_GRAPHEMES = 100;
/**
 * 絵文字に書く文字の上限。MOSS は6文字まで誤字なしだった。12文字（「素数を数えて落ち着くんだ」）は
 * 文字だけなら誤字なし、絵と並べると1文字混ざることがあった（2026-10-29）。崩れても、ご愛敬。
 * 句読点・「！？」・空白は数えない（letteringLength）。
 */
export const EMOJI_LETTERING_MAX_GRAPHEMES = 12;
/**
 * 1回の依頼で描く枚数。1枚30〜45秒（ComfyUI の起動が乗ると倍）かかるので、1枚にして、
 * 気に入らなければ頼み直してもらう。3枚だと待ちが数分になり、GPU を bot と取り合う時間も3倍になる。
 */
export const EMOJI_CANDIDATES = 1;
/** cutout の conflict がこれを超えたら、もう一方のキー色で撮り直す（検証で破綻 0.418、正常 ≤ 0.005）。 */
export const EMOJI_CONFLICT_THRESHOLD = 0.05;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeLength = (value: string) => [...segmenter.segment(value)].length;
/**
 * 上限の判定に使う文字数。句読点や「！？」は誤字の元にならず、セリフの末尾に付けたいだけで
 * 上限を超えると文字ごと捨てることになる（2026-10-30 の「俺たちの満足はこれからだ！」は13文字で落ちた）。
 */
const letteringLength = (value: string) =>
  [...segmenter.segment(value)].filter((s) => !/^[\p{P}\s]+$/u.test(s.segment)).length;

const ASPECTS: readonly EmojiAspect[] = ["square", "wide", "long", "xlong"];

/**
 * 3文字以上を正方形に収めると、26px のリアクション表示で読めない（検証で確認）。
 * Nagi は横長の絵文字を高さで揃えて出すので、文字数で横に伸ばす。
 * 文字の横に絵（キャラなど）も描くなら、もう1段広げる。同じ枠に並べると、文字が縦の3分の1ほどに
 * 縮み、本文の行の高さでは読めなかった（2026-10-28 の「新機能！」と botたん。文字は6px前後）。
 */
export function letteringAspect(text: string, drawing = false): EmojiAspect {
  const n = graphemeLength(text);
  return ASPECTS[(n <= 2 ? 0 : n <= 4 ? 1 : 2) + (drawing ? 1 : 0)];
}

export function parseEmojiGenerationInput(body: unknown): { prompt: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  // 改行や連続した空白は描かせても崩れるだけなので1つに詰める
  const prompt = typeof raw.prompt === "string" ? raw.prompt.replace(/\s+/g, " ").trim() : "";
  if (!prompt || graphemeLength(prompt) > EMOJI_PROMPT_MAX_GRAPHEMES)
    throw new ApiError(400, "invalid_request", `prompt must be 1-${EMOJI_PROMPT_MAX_GRAPHEMES} characters`);
  return { prompt };
}

/** 画素数を 768² 前後に揃える（MOSS は16の倍数）。 */
export const EMOJI_SIZES: Record<EmojiAspect, { width: number; height: number }> = {
  square: { width: 768, height: 768 },
  wide: { width: 1088, height: 544 },
  long: { width: 1280, height: 448 },
  xlong: { width: 1536, height: 384 },
};

const KEY_BACKGROUND: Record<ChromaKey, string> = {
  magenta: "on a solid flat pure magenta (#FF00FF) chroma key background with no gradient or shadow",
  green: "on a solid flat pure green (#00FF00) chroma key background with no gradient or shadow",
};

/** 被写体がマゼンタに近そうなら緑から始める。外れても cutout の conflict で撮り直せる。 */
export function initialChromaKey(prompt: string): ChromaKey {
  return /ピンク|ぴんく|桃色|ももいろ|マゼンタ|紫|むらさき|パープル|pink|magenta|purple|violet|fuchsia/i.test(prompt)
    ? "green"
    : "magenta";
}

export const otherChromaKey = (key: ChromaKey): ChromaKey =>
  key === "magenta" ? "green" : "magenta";

/** 画風は bot と同じすいばりさんの LoRA（bot_brain の buildImagePrompt.ts の MOSS_STYLES.suibari）。 */
const MOSS_CHECKPOINT = "moss_image_sft_int8_convrot.safetensors";
const SUIBARI_LORA: [string, number] = ["moss-suibari-v1-000006.safetensors", 1.0];
const SUIBARI_TRIGGER =
  "suibari style. A loose hand-drawn sketch with rough lines and simple flat colors.";
const NEGATIVE = "nsfw, worst quality, watermark, jpeg artifact";
/** 書く文字が無い絵文字は、MOSS が subject から文字を拾って小さく描き込まないよう止める。 */
const TEXT_NEGATIVE = "text, letters, writing";
/**
 * 絵文字は小さいので、人は胸から上までしか見分けられない。bot-tan-imagegen の promptConfig.json の
 * shots["upper-body"] と同じ言い方に「胸から上」を足し、全身はネガティブでも止める。
 */
const UPPER_BODY = "Upper-body view, from the chest up.";
const FULL_BODY_NEGATIVE = "full body, legs, feet, shoes";

/**
 * 描くたびに選ぶスタイル。シードを変えても構図も色もほぼ同じだった（検証）ので、頼み直したときに
 * 違う絵になるよう文で変える。
 * 文字の1つ目は白＋濃い縁の二重縁取りで、ライト・ダークどちらの背景でも沈まない。
 */
const STYLES: Array<{ lettering: string; extra: string }> = [
  { lettering: "in thick bold letters with a white inner outline and a dark outer outline", extra: "" },
  { lettering: "in thick bold letters with a dark outline and a few small sparkles around them", extra: " Drawn with a thick dark outline." },
  { lettering: "in chunky playful hand-drawn letters with a dark outline", extra: " Cute and round." },
];
export const EMOJI_STYLE_COUNT = STYLES.length;

/**
 * 本人の服の指定。none は指定なし（各キャラの署名の1着）、other は決まった服以外
 * （サンタ服、浴衣など。服は subject に書いてあるので、キャラの文からは服を外す）。
 */
export type EmojiOutfit = "none" | MossOutfitKind | "other";
const OUTFITS: readonly EmojiOutfit[] = ["none", "uniform", "casual", "pajamas", "swimsuit", "other"];

/**
 * botたんと仲間。gemma も MOSS も見た目を知らないので、名前が出てきたら bot の絵と同じ
 * 見た目と服の文（shared-configs の mossCharacters.ts）を描画の指示に足す。
 * 日本語の呼び方は本人のプロンプトから、英語名は gemma が書いた subject から拾う。
 */
const CHARACTERS: Array<{ pattern: RegExp; character: MossCharacter }> = [
  { pattern: /botたん|ボットたん|ぼっとたん|bot-?tan/i, character: MOSS_CHARACTERS["bot-tan"] },
  { pattern: /ラテちゃん|らてちゃん|latte-?chan/i, character: MOSS_CHARACTERS["latte-chan"] },
  { pattern: /ことみちゃん|コトミちゃん|kotomi-?chan/i, character: MOSS_CHARACTERS["kotomi-chan"] },
];
const MORPHO = /モルフォ|morpho/i;

/**
 * 服の指定に合わせたキャラの文。決まった服をそのキャラが持っていれば差し替え、持っていない服や
 * 決まった服以外なら服を書かない（subject の服の指定と食い違わないように）。
 */
function proseFor(character: MossCharacter, outfit: EmojiOutfit): string {
  if (outfit === "none") return mossCharacterProse(character);
  if (outfit !== "other" && character.outfits[outfit]) return mossCharacterProse(character, outfit);
  return mossCharacterProse(character, null);
}

/** プロンプトと subject に出てくるキャラの見た目の文。出てこなければ空。 */
export function characterDescriptions(text: string, outfit: EmojiOutfit = "none"): string[] {
  const found = CHARACTERS.filter((c) => c.pattern.test(text)).map((c) => proseFor(c.character, outfit));
  if (MORPHO.test(text))
    // botたんと一緒なら、bot の絵と同じく「彼女の犬」と書く
    found.push(
      found[0]?.startsWith("Bot-tan,") ? MOSS_MORPHO : "Morpho, a big fluffy white Samoyed dog",
    );
  return found;
}

/** gemma がプロンプトを分けた結果。 */
export type EmojiPlan = {
  /** 登録名の案（Bluemoji の名前規則 [a-zA-Z0-9_-]{1,32}）。本人は見て登録を押すだけにする。 */
  name: string;
  /** 登録時の説明（alt）の案。本人の言語で短く。 */
  description: string;
  /** 何を描くか（英文1〜2文）。文字だけの絵文字なら文字の説明でよい。 */
  subject: string;
  /** 絵文字に書く文字。無ければ undefined。 */
  lettering?: string;
  /** 書く文字の横に絵（キャラ・動物・物）も描くか。文字が無いときは付けない。 */
  drawing?: true;
  aspect: EmojiAspect;
  /** 服の指定（botたんたちの服の差し替えに使う）。 */
  outfit: EmojiOutfit;
};

export type EmojiImageRequest = {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  checkpoint: string;
  lora: Array<[string, number]>;
};

export function buildEmojiImageRequest(params: {
  plan: EmojiPlan;
  style: number;
  key: ChromaKey;
  /** characterDescriptions の結果。 */
  characters?: string[];
}): EmojiImageRequest {
  const { plan, key } = params;
  // キャラは「構図 → キャラ」の順に置く（promptConfig.json と同じ並び）
  const characters = params.characters?.length
    ? ` ${UPPER_BODY}${params.characters.map((d) => ` ${d}.`).join("")}`
    : "";
  const style = STYLES[params.style % STYLES.length];
  const shape =
    plan.aspect === "square"
      ? "A single emoji icon with bold simple shapes and no fine details."
      : "A single wide horizontal emoji badge with bold simple shapes and no fine details.";
  const fill =
    plan.aspect === "square" ? "Centered, filling most of the frame," : "Centered, filling the frame horizontally,";
  const subject = `${plan.subject.replace(/[.\s]+$/, "")}.`;
  // 絵と並べると文字が小さく描かれるので、文字を画像の高さいっぱいにさせる（絵は省かせない）
  const lettering = !plan.lettering
    ? style.extra
    : plan.drawing
      ? ` The text "${plan.lettering}" is written in one horizontal line beside the picture, ${style.lettering}. The letters are huge, as tall as the picture, filling the full height of the image.`
      : ` The text "${plan.lettering}" is written in one horizontal line, ${style.lettering}.`;
  return {
    prompt: `${SUIBARI_TRIGGER} ${shape} ${subject}${characters}${lettering} ${fill} ${KEY_BACKGROUND[key]}.`,
    negativePrompt: [
      NEGATIVE,
      ...(params.characters?.length ? [FULL_BODY_NEGATIVE] : []),
      ...(plan.lettering ? [] : [TEXT_NEGATIVE]),
    ].join(", "),
    ...EMOJI_SIZES[plan.aspect],
    checkpoint: MOSS_CHECKPOINT,
    lora: [SUIBARI_LORA],
  };
}

/**
 * プロンプトを MOSS 向けに分ける指示。日本語のまま MOSS に渡すと名詞は伝わるが、
 * 修飾や動作が落ちる（三毛→茶白、ガッツポーズ無し。docs/emoji-generation.md）ので英文にする。
 * 書く文字は訳さずそのまま残させる（MOSS は日本語の文字を正しく描ける）。
 */
export function planPrompt(prompt: string): string {
  return [
    "You turn a request for a small custom emoji into a plan for an image model. Return JSON only.",
    '- "subject": one or two short, plain English sentences describing what to draw. Keep every detail of the request (colors, patterns, poses, actions, objects) and add nothing. Do not mention backgrounds or art styles. Describe Japanese-specific words and wasei-eigo by what they look like (ガッツポーズ is a victory fist pump, not a guts pose). The emoji is tiny, so show people and animals from the chest up, never full body.',
    '- "lettering": the exact characters to write on the emoji, copied verbatim without translating, or "" if nothing should be written.',
    "  If the whole request is a short word or phrase meant to be shown as lettering (slang, a reaction, a greeting, a short exclamation), put it in lettering and describe it as lettering in subject.",
    "  If the request quotes words to write (in 「」 or quotes), put exactly those words in lettering.",
    '- Keep these character names as they are in English (their looks are added separately): Bot-tan (botたん), Latte-chan (ラテちゃん), Kotomi-chan (ことみちゃん), Morpho (モルフォ).',
    "- If the request names a character from an existing work (anime, manga, game, film, mascot), write the character's full official English name (given name and family name, not a title or nickname) and the title of the work (碇シンジ is Shinji Ikari from Neon Genesis Evangelion). Use the official English spelling, not a syllable-by-syllable romanization. Do not describe the character's looks yourself: the image model knows many characters by name, and a wrong description draws someone else. Keep any looks the request itself describes.",
    '- "drawing": true if anything besides the lettering should be drawn (a character, a person, an animal, an object), false if the emoji is only lettering.',
    '- "aspect": "wide" if the picture is naturally wide (a long object, a scene lined up side by side), otherwise "square".',
    '- "name": a short emoji name in lowercase ASCII letters, digits, "_" or "-" (at most 32 characters), like "fist_pump_penguin" or "sorena". Romanize Japanese words.',
    '- "description": a short description of the emoji in the same language as the request (at most 40 characters).',
    '- "outfit": the clothing the request asks the characters to wear: "uniform" (school uniform, 制服), "casual" (everyday clothes, 私服), "pajamas" (パジャマ), "swimsuit" (水着), "other" for any other specific clothing (describe it in subject), or "none" if the request says nothing about clothing.',
    "",
    `Request: ${prompt}`,
  ].join("\n");
}

export const EMOJI_PLAN_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    lettering: { type: "string" },
    drawing: { type: "boolean" },
    aspect: { type: "string", enum: ["square", "wide"] },
    name: { type: "string" },
    description: { type: "string" },
    outfit: { type: "string", enum: OUTFITS },
  },
  required: ["subject", "lettering", "drawing", "aspect", "name", "description", "outfit"],
} as const;

const clean = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/["“”\\]/g, "").replace(/\s+/g, " ").trim()
    : "";

/** Bluemoji の名前規則に合わせる。崩れていても登録できる名前にして返す（最後は "emoji"）。 */
export function normalizeEmojiName(value: unknown): string {
  const name = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 32)
    .replace(/[_-]+$/, "");
  return name || "emoji";
}

/** gemma の出力を検証する。おかしければ undefined（受付を 503 で断る）。 */
export function normalizeEmojiPlan(output: unknown, prompt = ""): EmojiPlan | undefined {
  const raw = (output ?? {}) as Record<string, unknown>;
  const subject = clean(raw.subject);
  if (!subject || subject.length > 400) return undefined;
  const name = normalizeEmojiName(raw.name);
  // 説明が無ければプロンプトをそのまま使う（どちらも本人の言語）
  const description = [...segmenter.segment(clean(raw.description) || prompt)]
    .slice(0, 100)
    .map((s) => s.segment)
    .join("");
  const outfit = OUTFITS.includes(raw.outfit as EmojiOutfit) ? (raw.outfit as EmojiOutfit) : "none";
  const lettering = clean(raw.lettering).replace(/^[「『]|[」』]$/g, "");
  if (lettering && letteringLength(lettering) <= EMOJI_LETTERING_MAX_GRAPHEMES) {
    // botたんたちの名前があれば、gemma が false と言っても描く（見た目の文が必ず足されるため）
    const drawing = raw.drawing === true || characterDescriptions(`${prompt} ${subject}`).length > 0;
    return {
      name,
      description,
      subject,
      lettering,
      ...(drawing ? { drawing: true as const } : {}),
      aspect: letteringAspect(lettering, drawing),
      outfit,
    };
  }
  // 長すぎる文字は書かせない（崩れるうえに、絵文字として読めない）。絵だけで描く。
  // subject に文字が残っていると、MOSS が正方形の中へ小さく描き込むので消す
  return {
    name,
    description,
    subject: lettering ? withoutLettering(subject, lettering) : subject,
    aspect: raw.aspect === "wide" ? "wide" : "square",
    outfit,
  };
}

/** subject から書く文字と、その前の「the lettering」「the words」などを消す。消しすぎて空なら元のまま。 */
function withoutLettering(subject: string, lettering: string): string {
  const escaped = lettering.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = subject
    .replace(
      new RegExp(`(?:\\s*\\b(?:the\\s+)?(?:lettering|words?|text|phrase)\\b)?\\s*[「『']?${escaped}[」』']?`, "gi"),
      "",
    )
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.replace(/[.\s]/g, "") ? stripped : subject;
}
