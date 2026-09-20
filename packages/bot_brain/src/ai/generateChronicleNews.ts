import { Type } from "@google/genai";
import {
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
} from "@bsky-affirmative-bot/shared-configs";
import { generateContentWithRetry } from "./util.js";
import { rejectChronicleTone } from "./generateChronicleMonth.js";

/**
 * 年表の「そのころ世の中では」を、**その月に1件だけ**選ぶ。
 *
 * 日記のロールアップ（generateChronicleMonth）とは完全に別。
 * **利用者の話とは関係なくてよい。** これは「その月に世の中で何があったか」を年表の
 * 背景として置くもので、その人の日記と響き合う必要はない。
 * したがって呼び出しは【人数 × 月】ではなく【月】だけで、結果は全員で共用する。
 */

/** v1: 初版。 */
export const NAGI_CHRONICLE_NEWS_PROMPT_VERSION = "nagi-chronicle-news-v1";

export const CHRONICLE_NEWS_TITLE_MAX_JA = 24;
export const CHRONICLE_NEWS_TITLE_MAX_EN = 48;

/**
 * 候補の上限。
 *
 * 1か月のニュースは最大 620件（1日20件 × 31日）あり、全部は載せられない。
 * 載せられたとしても、12B のモデルに 600件から1件を番号で選ばせるのは当てにならない。
 * 反応の多い順に絞ってから渡す（誰かが気に留めた記事、という弱いながら実在の信号）。
 */
export const CHRONICLE_NEWS_CANDIDATE_LIMIT = 60;

export interface ChronicleNewsCandidate {
  /** 表示中の言語での見出し。 */
  title: string;
  /** "YYYY-MM-DD"。同じ月の中のいつごろかを添える。 */
  date: string;
}

export interface ChronicleNewsInput {
  /** "YYYY-MM"。 */
  month: string;
  candidates: ChronicleNewsCandidate[];
}

export interface ChronicleNewsResult {
  /** 選んだ候補の添字。選ばなかったときは undefined。 */
  index?: number;
  titleJa?: string;
  titleEn?: string;
}

const clip = (value: unknown, max: number): string =>
  [...String(value ?? "").trim().replace(/\s+/g, " ")].slice(0, max).join("");

/** 指示ブロック。SYSTEM_INSTRUCTION に続けて systemInstruction へ入れる。 */
export function buildChronicleNewsInstruction(month: string): string {
  return `
# いまやること
${month} の年表に「そのころ世の中では」として並べる出来事を、下の候補から**1件だけ**選びます。
みんなが自分の年表を見返したときに、その月の空気を思い出すための1行です。

# 選び方
* **特定の誰かの話と結びつける必要はありません。** これは世の中の出来事の欄です。
* 「何年か経ってからこの月を振り返ったときに、そういえばこんなことがあった、と思い出すのはどれか」
  だけで選んでください。ニュースそのものの重大さより、**その月の目印になるか**です。
* 候補は**全肯定ニュース**なので、明るい話題しか入っていません。事件や事故の類は
  そもそも候補になりません。その中から選んでください。
* **多くの人が知っている出来事**を優先してください。ごく狭い界隈の話や、
  「〜が話題」「〜してみた」のような一過性の小ネタは避けます。
* **基本は1件選びます。** 候補が並んでいるなら、その中でいちばん記憶に残るものを選んでください。
  完璧な1件でなくて構いません。どうしても年表に残すに値する出来事が無い月だけ、
  index に ${CHRONICLE_NEWS_SKIP} を返してください。

# 書き方
* 見出しは候補の内容から外れないこと。**候補に書かれていないことを足さない。**
* 日本語 ${CHRONICLE_NEWS_TITLE_MAX_JA} 字以内、英語 ${CHRONICLE_NEWS_TITLE_MAX_EN} 字以内。
* **URL や日付を自分で書かないこと。**
${TONE_RULES_JA}`;
}

/** 候補ブロック。指示は混ぜない（fitOllamaMessages が末尾を残して切るため）。 */
export function buildChronicleNewsMaterial(input: ChronicleNewsInput): string {
  const list = input.candidates
    .map((c, index) => `${index}. (${c.date}) ${c.title}`)
    .join("\n");
  return `<news_candidates month="${input.month}">\n${list}\n</news_candidates>`;
}

/**
 * 候補の添字でしか選べないようにする。見出しも URL も自由記述させない。
 *
 * **3つとも required にして、棄権は -1 という明示的な選択にしてある。**
 * 以前は `required: []` で「キーごと省けば棄権」にしていたが、それだと `{}` が
 * 文法上いちばん短い正解になり、実測で**どの月も必ず棄権した**（本番の7月・8月とも）。
 * 選ばせたいなら、選ばないほうに逃げ道を作らないこと。
 */
export const CHRONICLE_NEWS_SKIP = -1;

export function chronicleNewsSchema(candidateCount: number) {
  return {
    type: Type.OBJECT,
    properties: {
      index: {
        type: Type.INTEGER,
        minimum: CHRONICLE_NEWS_SKIP,
        maximum: Math.max(0, candidateCount - 1),
        description:
          `年表に並べる出来事の番号。どうしても残すほどの出来事が無い月だけ ${CHRONICLE_NEWS_SKIP} を返す。`,
      },
      titleJa: {
        type: Type.STRING,
        description: `年表に出す日本語の見出し（${CHRONICLE_NEWS_TITLE_MAX_JA}字以内）。`,
      },
      titleEn: {
        type: Type.STRING,
        description: `titleJa と同じ内容の自然な英語（${CHRONICLE_NEWS_TITLE_MAX_EN}字以内）。`,
      },
    },
    required: ["index", "titleJa", "titleEn"],
    propertyOrdering: ["index", "titleJa", "titleEn"],
  };
}

/** 応答を検証して、信用できるものだけ残す。 */
export function acceptChronicleNews(
  input: ChronicleNewsInput,
  json: unknown,
): ChronicleNewsResult {
  const raw = (json ?? {}) as Record<string, unknown>;
  const index = Number(raw.index);
  if (index === CHRONICLE_NEWS_SKIP) return {};
  const titleJa = clip(raw.titleJa, CHRONICLE_NEWS_TITLE_MAX_JA);
  const titleEn = clip(raw.titleEn, CHRONICLE_NEWS_TITLE_MAX_EN);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= input.candidates.length ||
    !titleJa ||
    !titleEn ||
    rejectChronicleTone(titleJa) ||
    rejectChronicleTone(titleEn)
  )
    return {};
  return { index, titleJa, titleEn };
}

export async function generateChronicleNews(
  input: ChronicleNewsInput,
): Promise<ChronicleNewsResult> {
  if (!input.candidates.length) return {};

  const response = await generateContentWithRetry(
    {
      feature: "NAGI_CHRONICLE_NEWS",
      contents: [buildChronicleNewsMaterial(input)],
      maxTextLength: null,
      config: {
        systemInstruction: `${SYSTEM_INSTRUCTION}\n${buildChronicleNewsInstruction(input.month)}`,
        responseMimeType: "application/json",
        responseSchema: chronicleNewsSchema(input.candidates.length),
        // 番号と短い見出し2本だけ。
        maxOutputTokens: 512,
        temperature: 0.4,
      },
    },
    3,
  );

  try {
    return acceptChronicleNews(input, JSON.parse(response.text || "{}"));
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateChronicleNews:",
      e,
    );
    return {};
  }
}
