import { isJapaneseDayOff } from "@bsky-affirmative-bot/shared-configs";
import { ollamaChat } from "../ollamaChat.js";

/**
 * 絵の botたんに着せる服。
 *
 * 以前は制服のタグを固定で連結していたので、休日の自宅でもパジャマで寝坊した朝でも制服だった。
 * bot-tan-calender の outfit.py と同じ作りで、**どれを着るかは場面からコードで決め、
 * LLM には服のタグを書かせない**（外見と同じく、揺れるとキャラが崩れる）。LLM が出すのは
 * 場所・泳いでいるか・本文が服を明記しているか、という手がかりだけ。
 *
 * 私服だけは予定表の「今日の服」の文をタグに起こす（1日1回、文が変わるまで使い回す）。
 * 起こせなかった日は既定の私服を着せる。黙って制服に戻すより私服の日らしく見える。
 */

export type BotOutfit = "uniform" | "casual" | "pajamas" | "swimsuit";

export type ScenePlace = "school" | "home" | "outing";

/** シーン変換の LLM が返す、服を選ぶ手がかり。 */
export type SceneCues = {
  place: ScenePlace;
  swimming: boolean;
  /** 本文が服をはっきり書いているときだけ入る。 */
  stated: "" | "uniform" | "casual" | "pajamas";
};

export const DEFAULT_SCENE_CUES: SceneCues = { place: "home", swimming: false, stated: "" };

type OutfitSpec = { tags: string; negative: string };

/**
 * タグは bot-tan-calender の prompt_config.json と同じもの。私服の既定は設定文の
 * 「お気に入り」（ミント色のカーディガン・フリル付きの白シャツ・青色のスカート）。
 * negative は botたん1人の絵でだけ足す（2人の絵では仲間の服まで消える）。
 */
export const BOT_TAN_OUTFITS: Record<BotOutfit, OutfitSpec> = {
  uniform: {
    tags: "school uniform, mint green sweater, long sleeves, white collared shirt, blue neck ribbon, blue pleated skirt, white socks, brown loafers",
    negative: "",
  },
  casual: {
    tags: "mint green cardigan, open cardigan, white shirt, frilled shirt, long sleeves, blue skirt",
    negative: "school uniform, neck ribbon",
  },
  pajamas: {
    tags: "light blue pajamas, long sleeves, pants",
    negative: "school uniform, sweater, skirt",
  },
  swimsuit: {
    tags: "light blue one-piece swimsuit, frilled swimsuit",
    negative: "bikini, micro bikini, school swimsuit, competition swimsuit, slingshot swimsuit, tan, tanlines",
  },
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 予定表と同じく朝4時で日付を切り替える（botDayRange）。 */
const BOT_DAY_START_HOUR = 4;

/**
 * 家でパジャマを着ている時間帯（JST）。bot-tan-calender の outfit.py と同じ値。
 * 以前は時間帯の night（19〜6時）に合わせていたが、19時は夕ごはんやゲームの時間で私服の
 * ほうが自然。お風呂上がりの21時から朝6時まで。21時前でも、本文がお風呂上がりなら
 * シーン変換が clothing=pajamas を返す。
 */
const PAJAMA_START_HOUR = 21;
const PAJAMA_END_HOUR = 6;

export function isPajamaHour(now: Date): boolean {
  const hour = new Date(now.getTime() + JST_OFFSET_MS).getUTCHours();
  return hour >= PAJAMA_START_HOUR || hour < PAJAMA_END_HOUR;
}

export function isBotDayOff(now: Date): boolean {
  const day = new Date(now.getTime() + JST_OFFSET_MS - BOT_DAY_START_HOUR * 60 * 60 * 1000);
  return isJapaneseDayOff(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
}

/**
 * 場面に合う服を選ぶ。
 *
 * 水着は泳いでいる場面だけ。本文が服を明記していればそれに合わせる（「制服に着替えている」の
 * WakeUp など）。status はバイオリズムの状態で、分からない呼び出し（お絵描き・おやすみの絵）は
 * 渡さない。おやすみの絵は「その日の場面」を描くので、Sleep を渡すとパジャマになってしまう。
 */
export function chooseBotOutfit(args: { cues: SceneCues; status?: string; now: Date }): BotOutfit {
  const { cues, status, now } = args;
  if (cues.swimming) return "swimsuit";
  if (cues.stated) return cues.stated;
  if (status === "Sleep") return "pajamas";
  if (cues.place === "school") return "uniform";
  if (cues.place === "home") {
    return status === "WakeUp" || isPajamaHour(now) ? "pajamas" : "casual";
  }
  // おでかけ。平日は放課後に学校から寄っているので制服のまま。
  return isBotDayOff(now) ? "casual" : "uniform";
}

/** シーン変換の出力から手がかりを読む。読めなかった項目は「家・泳いでいない・書かれていない」に倒す。 */
export function parseSceneCues(value: Record<string, unknown>): SceneCues {
  const place = typeof value.place === "string" ? value.place.trim().toLowerCase() : "";
  const clothing = typeof value.clothing === "string" ? value.clothing.trim().toLowerCase() : "";
  const stated: SceneCues["stated"] =
    clothing === "school uniform" ? "uniform" : clothing === "casual clothes" ? "casual" : clothing === "pajamas" ? "pajamas" : "";
  return {
    place: place === "school" || place === "outing" ? place : "home",
    swimming: value.swimming === true,
    stated,
  };
}

/**
 * シーンのタグから落とす服の語。服は上で選ぶので、混ざると選んだ服と競合する。
 * 寝具（pajamas など）は SLEEP_PATTERN も落とすが、ここでも明示しておく。
 */
export const CLOTHING_TAG_PATTERN =
  /\b(school uniform|uniform|serafuku|sailor|sweater|cardigan|blazer|pajamas?|pyjamas?|swimsuit|bikini|casual|skirt|dress|shirt|hoodie|jacket|coat|neck ribbon|loafers|socks)\b/;

// --------------------------------------------------------------- 予定表の私服

const CASUAL_SCHEMA = {
  type: "object",
  properties: { tags: { type: "array", items: { type: "string" } } },
  required: ["tags"],
};

const CASUAL_SYSTEM = `You convert a Japanese sentence describing an anime girl's outfit into Danbooru-style English clothing tags for an anime image generator.

Rules:
* Output ONLY lowercase Danbooru tags for clothes and shoes, 1-4 words each. Put the color in the tag when the sentence gives one (e.g. white shirt, blue skirt, mint green cardigan).
* 3-7 tags. Include the top and the bottom (or a dress).
* NEVER output hair, eyes, face, body, accessories in the hair, or character names.
* NEVER output revealing or sexual clothing, underwear, swimsuits, or school uniforms.
* If the sentence does not describe clothes, return an empty list.`;

/**
 * 私服に入れさせない語。髪や目（外見は固定タグの担当）、露出、水着、制服、ほかの子の署名の服。
 * ことみちゃんは「ピンクのシャツと黒いフリルのスカート」、ラテちゃんはメイド服で固定なので、
 * botたんが同じ服を着ると2人の絵で見分けが髪色だけになる。
 */
const CASUAL_BLOCK =
  /\b(hair|eyes?|ahoge|ears?|tail|skin|breasts?|swimsuit|bikini|uniform|serafuku|sailor|maid|corset|pink (shirt|blouse|top)|black( [a-z]+)* skirt|black footwear|puffy short sleeves|frilled sleeves|midriff|navel|cleavage|see-through|revealing|backless|strapless|off[- ]shoulder|crop top|micro|thighhighs|garter|nsfw|underwear|panties|lingerie)\b/;
const MAX_CASUAL_TAGS = 8;

export function cleanCasualTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const raw of tags) {
    const tag = String(raw).trim().toLowerCase().replace(/_/g, " ");
    if (!tag || tag.split(/\s+/).length > 4 || CASUAL_BLOCK.test(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out.slice(0, MAX_CASUAL_TAGS);
}

/** 同じ文は二度変換しない。予定表の服は1日1文なので、プロセス内の1件だけ覚えておけば足りる。 */
let casualCache: { sentence: string; tags: string } | undefined;

/**
 * 予定表の「今日の服」の文を私服のタグにする。起こせなければ空文字（呼び出し側は既定の私服）。
 * 失敗しても投げない。私服が起こせなくても絵は描ける。
 */
export async function casualOutfitTags(
  sentence: string | undefined,
  convert: (sentence: string) => Promise<unknown> = convertCasual,
): Promise<string> {
  const text = sentence?.trim();
  if (!text) return "";
  if (casualCache?.sentence === text) return casualCache.tags;
  let tags = "";
  try {
    tags = cleanCasualTags(await convert(text)).join(", ");
  } catch (error) {
    console.warn("[WARN][IMGGEN] 私服をタグにできなかった。既定の私服を着せる:", error);
    return "";
  }
  console.log(`[INFO][IMGGEN] 今日の私服: ${text} → ${tags || "（既定の私服）"}`);
  casualCache = { sentence: text, tags };
  return tags;
}

async function convertCasual(sentence: string): Promise<unknown> {
  const raw = await ollamaChat(
    "BSKY_IMAGE_PROMPT",
    [
      { role: "system", content: CASUAL_SYSTEM },
      { role: "user", content: sentence },
    ],
    { maxTokens: 200, temperature: 0.2, timeoutMs: 60_000, format: CASUAL_SCHEMA },
  );
  return (JSON.parse(raw) as { tags?: unknown }).tags;
}

/** 着る服のタグとネガティブ。私服は予定表から起こしたタグがあればそれを使う。 */
export function botOutfitSpec(kind: BotOutfit, casualTags = ""): OutfitSpec {
  const spec = BOT_TAN_OUTFITS[kind];
  return kind === "casual" && casualTags ? { ...spec, tags: casualTags } : spec;
}

/** テスト用。プロセス内のキャッシュを空にする。 */
export function resetCasualOutfitCacheForTest(): void {
  casualCache = undefined;
}
