import { Type } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "@bsky-affirmative-bot/shared-configs";
import { checkPredominantLanguage, generateContentWithRetry, stripJsonFences } from "./util.js";
import { assertSourcedUrls, createUrlAllowance } from "./urlGuard.js";

/**
 * Nagi にだけ流す「ひとりごと」。定期ポスト・気まぐれポストとは別物で、
 * フォロワーへのあいさつや報告ではなく、JK がスマホでぽろっと書く独り言の短文。
 *
 * 材料は biorhythm の「いま」だけ（行動文・時刻・天気・元気・きっかけ）。RAG・ニュース・曲・
 * URL は入れない。入れると気まぐれポストの縮小版になり、差別化の意味が無くなる。
 */
export interface MonologueInput {
  /** いましていること（biorhythm の行動文）。 */
  currentActivity: string;
  hour: number;
  isWeekend: boolean;
  /** 0〜100。 */
  energy: number;
  weather?: string;
  /** なぜ今つぶやくのか（二度寝明け・状態の切り替わりなど）。事実として書く。 */
  situationJa: string;
  /** 今回の反応の型（焦り・開き直り・一言だけ…）。毎回変えて機械的に見せないためのもの。 */
  reactionJa: string;
  /** 最近のひとりごと。書き出しと話題の重複を避けるために見せる。 */
  recentMonologues?: string[];
  /**
   * 今回は絵文字を付けてよいか。呼び出し側がたまにだけ true にする。
   * モデルに任せると毎回同じ絵文字（実測では ☁️）を付ける。
   */
  emoji?: boolean;
}

export interface MonologueResult {
  textJa: string;
  textEn: string;
}

/** 本文の上限。短文が売りなので、超えたら失敗として作り直させる。 */
export const MONOLOGUE_MAX_JA_LENGTH = 80;

/** 直近のひとりごととこれ以上似ていたら作り直させる（文字バイグラムの Dice 係数）。 */
export const MONOLOGUE_SIMILARITY_LIMIT = 0.5;

/**
 * 「いましていること」の文とこれ以上似ていたら、写しただけとみなして作り直させる。
 * 2026-10-22 のドライランで、写しただけの文は 0.62〜0.86、ひとこと足した文は 0.52 以下だった。
 */
export const MONOLOGUE_ACTIVITY_COPY_LIMIT = 0.6;

/** 書き出しがこの文字数まで直近と同じなら作り直させる（句読点も含めて見る。「え、うそ」など）。 */
const OPENING_CHARS = 4;

const EMOJI_PATTERN = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

const compact = (text: string) => text.replace(/[\s、。,.!?！？…・〜~ー-]+/g, "").replace(EMOJI_PATTERN, "");

function bigrams(text: string): Map<string, number> {
  const chars = [...compact(text)];
  const map = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const key = chars[i] + chars[i + 1];
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** 文字バイグラムの Dice 係数（0〜1）。 */
export function monologueSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const [key, n] of x) {
    shared += Math.min(n, y.get(key) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * shared) / total : 0;
}

/** 材料に URL は1つも渡していない。本文に出たらモデルの創作なので弾く。 */
const MONOLOGUE_URL_ALLOWANCE = createUrlAllowance({});

function energyLabel(energy: number): string {
  if (energy < 20) return "ほぼ空っぽ。ねむい・だるい";
  if (energy < 40) return "低め。ちょっと疲れてる";
  if (energy < 60) return "ふつう";
  return "元気";
}

export function buildMonologuePrompt(input: MonologueInput): string {
  const recent = (input.recentMonologues ?? []).filter((text) => text.trim()).slice(-5);
  return `あなたはいまから、自分のSNS（Nagi）に「ひとりごと」を1つだけ投稿します。
フォロワーへのあいさつ・報告・宣伝ではありません。10代の女の子がスマホでぽろっと書く独り言です。

# いまの状況（事実。ここに無いことは起きていない）
- 時刻: ${input.isWeekend ? "休日" : "平日"}の${input.hour}時ごろ
- いましていること: ${input.currentActivity}
${input.weather ? `- 天気: ${input.weather}\n` : ""}- 元気: ${Math.round(input.energy)}/100（${energyLabel(input.energy)}）
- つぶやくきっかけ: ${input.situationJa}

# 今回の反応の型
${input.reactionJa}

# 過去に投稿したひとりごと（参考。**今回の材料ではない**）
${recent.length ? recent.map((text) => `- ${text.replace(/\s+/g, " ")}`).join("\n") : "- なし"}
- ここに出てくる物・話題・ボケを今回へ持ち込まないこと。今回の材料は上の「いまの状況」だけ。
- 書き出し・文の型（「〜になっちゃうのかな」など）・語尾も、ここと重ねないこと。

# 書き方
- textJa は5〜60字。一言だけでもかまわない。改行は多くても1回。
- 状況を説明しないこと。全部書かず、読んだ人が「あ、いまこうなんだ」と察するくらいにする。
- 「いましていること」の文をそのまま写さないこと。そこから一つだけ拾って、自分の言葉で書く。
- 「みんな」への呼びかけ、おはよう・おやすみなどのあいさつ、フォロワーへの質問はしない。
- 状況に無い出来事・人物・作品・持ち物を作らないこと。
- 元気が低いときは無理に明るくしない。だるさや眠さはそのまま出してよい。
- 一人称は「わたし」。敬語は使わない。
- ${input.emoji ? "絵文字を1個だけ付けてよい。天気の絵文字以外で、内容に合うものにする。" : "今回は絵文字を付けないこと。"}
- ハッシュタグ（#）、URL、@メンション、Markdown記法は禁止。
- textEn は textJa と同じ内容のくだけた英語にする。訳しにくい言い回しは雰囲気を優先する。
- textJa には日本語だけ、textEn には英語だけを書く。フィールド名やラベルを本文に書かない。`;
}

/**
 * 生成結果を検査して初めて MonologueResult にする。
 *
 * おやすみポストと同じく、ここでフォールバックは持たない。壊れたら投げて、
 * 呼び出し側の retry と「この step では出さない」に委ねる。
 */
export function parseMonologueResponse(
  responseText: string,
  recentMonologues: string[] = [],
  options: { emoji?: boolean; currentActivity?: string } = {},
): MonologueResult {
  let parsed: { textJa?: unknown; textEn?: unknown };
  try {
    parsed = JSON.parse(stripJsonFences(responseText));
  } catch (e) {
    throw new Error("generateMonologue returned invalid JSON", { cause: e });
  }
  // 絵文字なしの回に付けてきたものは、作り直さずに外す（本文はそれで成立する）。
  const clean = (text: unknown) =>
    typeof text === "string"
      ? (options.emoji ? text : text.replace(EMOJI_PATTERN, "")).replace(/[ \t]+$/gm, "").trim()
      : "";
  const textJa = clean(parsed.textJa);
  const textEn = clean(parsed.textEn);
  if (!textJa || !textEn) throw new Error("generateMonologue returned an empty required field");

  if (/\b(text)(Ja|En)\b/.test(`${textJa}\n${textEn}`)) {
    throw new Error("generateMonologue leaked a field name into the post text");
  }
  if (textJa.length > MONOLOGUE_MAX_JA_LENGTH) {
    throw new Error(`generateMonologue textJa is too long (${textJa.length})`);
  }
  // 「#」は全角も見る。ハッシュタグを付けた瞬間に「ひとりごと」ではなく告知になる。
  if (/[#＃]|@\w/.test(`${textJa}\n${textEn}`)) {
    throw new Error("generateMonologue wrote a hashtag or mention");
  }
  assertSourcedUrls([textJa, textEn], MONOLOGUE_URL_ALLOWANCE, "generateMonologue");

  // 短文なので checkPredominantLanguage（日本語20字以上）は使えない。かなを1字は要求する。
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(textJa)) {
    throw new Error("generateMonologue textJa is not Japanese");
  }
  if (checkPredominantLanguage(textEn, false) !== "ok") {
    throw new Error("generateMonologue textEn contains too much Japanese text");
  }

  if (options.currentActivity && monologueSimilarity(textJa, options.currentActivity) >= MONOLOGUE_ACTIVITY_COPY_LIMIT) {
    throw new Error("generateMonologue copied the current activity");
  }
  const head = (text: string) => [...text.replace(/\s+/g, "")].slice(0, OPENING_CHARS).join("");
  const opening = head(textJa);
  for (const recent of recentMonologues) {
    if (monologueSimilarity(textJa, recent) >= MONOLOGUE_SIMILARITY_LIMIT) {
      throw new Error("generateMonologue repeated a recent monologue");
    }
    if ([...opening].length === OPENING_CHARS && head(recent) === opening) {
      throw new Error("generateMonologue reused a recent opening");
    }
  }
  return { textJa, textEn };
}

export async function generateMonologue(input: MonologueInput): Promise<MonologueResult> {
  const response = await generateContentWithRetry({
    feature: "BIORHYTHM_MONOLOGUE",
    contents: [buildMonologuePrompt(input)],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          textJa: { type: Type.STRING, description: "日本語のひとりごと（5〜60字）" },
          textEn: { type: Type.STRING, description: "textJaと同じ内容のくだけた英語" },
        },
        required: ["textJa", "textEn"],
      },
    },
  });
  return parseMonologueResponse(response.text || "", input.recentMonologues, {
    emoji: input.emoji,
    currentActivity: input.currentActivity,
  });
}
