import { Type } from "@google/genai";
import {
  estimateMessagesTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
} from "@bsky-affirmative-bot/shared-configs";
import { generateContentWithRetry } from "./util.js";
import { validateChaosExcerpt } from "./generateUserDiary.js";

/**
 * 自分年表の月次ロールアップ。
 *
 * 前月ぶんの日記をまとめて読み、**その月の「大きな出来事」**を0〜3件選ぶ。
 *
 * 「そのころ世の中では」は**ここでは扱わない**（generateChronicleNews が月ごとに1回、
 * 全ユーザー共通で選ぶ）。あれは世の中の出来事の欄で、その人の日記とは無関係でよい。
 *
 * generateZenkatsuAward と同じ「計算はサーバ、読み解きと選択はモデル」の分担にしてある。
 * モデルがやるのは「どれを選ぶか」と「短い見出しを書くこと」だけで、日付もニュースも
 * **自由記述させない**（下の responseSchema を参照）。
 */

/** v1: 初版。 */
export const NAGI_CHRONICLE_PROMPT_VERSION = "nagi-chronicle-v1";

/** 見出し・ひとことの上限。年表は一覧で読むので、長いと軸が崩れる。 */
export const CHRONICLE_TITLE_MAX_JA = 20;
export const CHRONICLE_TITLE_MAX_EN = 40;
export const CHRONICLE_DETAIL_MAX_JA = 60;
export const CHRONICLE_DETAIL_MAX_EN = 120;

/** 1か月から選ぶ出来事の上限。**下限は無い。0件の月は正常。** */
export const CHRONICLE_MAX_HIGHLIGHTS = 3;

/** 逐語抜粋の最小文字数。validateChaosExcerpt と揃える。 */
const EVIDENCE_MIN_CHARS = 12;

/** 1件あたりの本文の上限と下限。予算から逆算した値をこの範囲へ丸める。 */
const DIARY_CAP_MIN = 200;
/**
 * 1件あたりの上限。実測（本番の2026-08、日記29件）で本文は中央値 517字・最大 1080字あり、
 * 480 だと予算を 4,500 トークン余らせたまま 1,594字を捨てていた。
 * 予算の逆算（chronicleDiaryCap）が実際に効く高さまで上げてある。
 */
const DIARY_CAP_MAX = 900;

export interface ChronicleMonthDiary {
  /** "YYYY-MM-DD"。responseSchema の enum になるので、実在する日付だけを渡すこと。 */
  date: string;
  /** その日の称号。見出しではないが、月の雰囲気を掴む助けになる。 */
  titleJa?: string;
  text: string;
}

export interface ChronicleMonthInput {
  displayName: string;
  /** "YYYY-MM"。 */
  month: string;
  /** 日本語で書かせるか。日記と同じ判定を呼び出し側から渡す。 */
  japanese: boolean;
  /** その月の日記。日付昇順。 */
  diaries: ChronicleMonthDiary[];
}

export interface ChronicleHighlight {
  date: string;
  titleJa: string;
  titleEn: string;
  detailJa: string;
  detailEn: string;
  /** その日の日記からの逐語抜粋。表示しない（検証用）。 */
  evidence: string;
}

export interface ChronicleMonthResult {
  highlights: ChronicleHighlight[];
}

/**
 * 全肯定と正面から衝突する言い回しを落とす。
 *
 * docs/zenkatsu.md 3.4 のとおり、このプロジェクトは**数えた瞬間に義務になる**ものを数えない。
 * プロンプトの禁止文だけでは確率的にしか守られないので、サーバ側でも弾いて
 * **テストできる形**にしてある。年表は本人がずっと見返す場所なので、ここは強めに倒す。
 */
const TONE_REJECT = [
  /連続/,
  /ストリーク/,
  /\d+日続/,
  /毎日欠かさ/,
  /記録更新/,
  /自己ベスト/,
  /ランキング/,
  /第?\s*1\s*位/,
  /達成率/,
  /去年より/,
  /先月より/,
  /streak/i,
  /in a row/i,
  /record high/i,
  /ranking/i,
];

export function rejectChronicleTone(text: string): boolean {
  return TONE_REJECT.some((pattern) => pattern.test(text));
}

const clip = (value: unknown, max: number): string =>
  [...String(value ?? "").trim().replace(/\s+/g, " ")].slice(0, max).join("");

/**
 * 1件あたりに載せてよい本文の長さ。
 *
 * 日記は日本語で350〜500字が目安だが、上限は clipNagiPostText の3000書記素なので、
 * **素直に全文を載せると最悪月で num_ctx を溢れる。** 予算から逆算して丸める。
 * 先頭を残すのは、日記が「中心となる出来事」を第1〜2段落に置く設計だから
 * （generateUserDiary のプロンプト参照）。
 */
export function chronicleDiaryCap(
  diaryCount: number,
  /** 日記本文以外に送る文字数（SYSTEM_INSTRUCTION・指示・ニュース候補・見出し行）。 */
  overheadChars: number,
  numCtx = ollamaTextContextLength(),
  outputTokens = 2048,
): number {
  if (diaryCount <= 0) return DIARY_CAP_MIN;
  const budget = ollamaPromptBudget({ numCtx, outputTokens });
  // 日本語は約1.1トークン/字、全体に安全係数1.15。逆算するので割る。
  const usableChars = Math.floor(budget / (1.1 * 1.15)) - overheadChars;
  const per = Math.floor(usableChars / diaryCount);
  return Math.min(DIARY_CAP_MAX, Math.max(DIARY_CAP_MIN, per));
}

/**
 * 材料ブロック。**指示は入れない。**
 *
 * fitOllamaMessages は (1) 中間メッセージを丸ごと落とし (4) 最終手段では末尾を残して切るので、
 * 指示と材料を同じ文字列に混ぜると、予算が苦しいときに**指示のほうが先に消える**。
 * 指示は config.systemInstruction に置くこと（そちらは削られない）。
 * これで AGENTS.md の「ユーザの投稿はいちばん後ろ」も同時に満たせる。
 */
export function buildChronicleMonthMaterial(input: ChronicleMonthInput): string {
  /*
   * 日記本文以外に送るぶんを**実測して**差し引く。
   *
   * 以前は 400 + ニュース件数×40 という当て推量で、SYSTEM_INSTRUCTION（約3,960字）も
   * 指示ブロック（約1,800字）も数えていなかった。そのぶん usableChars が過大になり、
   * 実際に予算を守っていたのは DIARY_CAP_MAX の上限だけ、という状態だった。
   * つまり逆算が効いておらず、上限を上げた瞬間に溢れる。ここを実測に変えて、
   * 逆算のほうが効くようにしてある。
   */
  const overhead =
    SYSTEM_INSTRUCTION.length +
    buildChronicleMonthInstruction(input).length +
    // "## YYYY-MM-DD（称号: …）" の見出し行と空行。
    input.diaries.reduce((n, d) => n + 16 + (d.titleJa?.length ?? 0) + 8, 0);
  const cap = chronicleDiaryCap(input.diaries.length, overhead);
  const diaries = input.diaries
    .map((diary) => {
      const body = [...diary.text.trim()].slice(0, cap).join("");
      const title = diary.titleJa ? `（称号: ${diary.titleJa}）` : "";
      return `## ${diary.date}${title}\n${body}`;
    })
    .join("\n\n");
  return `<diaries month="${input.month}" subject="${input.displayName}">
${diaries}
</diaries>`;
}

/** 指示ブロック。SYSTEM_INSTRUCTION に continue する形で systemInstruction へ入れる。 */
export function buildChronicleMonthInstruction(
  input: ChronicleMonthInput,
): string {
  const lang = input.japanese ? "日本語" : "英語";
  return `
# いまやること
${input.displayName} さんの「自分年表」に載せる節目を、${input.month} の日記から選びます。
あなたが選んだものは、その人があとから何度も見返す場所に**ずっと残ります**。

# 最重要（ここを間違えないこと）
* 日記に書かれていないことを足さないこと。**推測で補わない。**
* 行為者を取り違えないこと。日記に出てくる家族・友人がやったことを、本人がやったことにしない。
* まだ終わっていないこと（「〜したら」「〜する予定」）を、**終わったことにして祝わない。**
* 迷ったら**選ばない**。この月に節目が無いのは、まったく正常です。0件で構いません。

# 選び方
* 「その月をあとから思い出すとき、目印になるか」だけで選んでください。
* 多くても ${CHRONICLE_MAX_HIGHLIGHTS} 件まで。似たものが続くなら1件にまとめず、どれか1つだけ選ぶこと。
* 日常のささやかなことでも、その人にとって区切りなら選んでよいです。

# 絶対に書かないこと（このアプリは全肯定がコンセプトです）
* **連続日数・ストリークを数えない。** 数えた瞬間に「途切れさせてはいけない義務」になります。
* **他の月や去年と比べない。** 「今月は少なかった」は書かない。
* **順位・点数・達成率を書かない。**
* 足りなかったこと・できなかったことを指摘しない。

# 書き方
* title は ${lang} で、その日を指す短い見出し（日本語 ${CHRONICLE_TITLE_MAX_JA} 字以内 / 英語 ${CHRONICLE_TITLE_MAX_EN} 字以内）。
* detail はひとこと（日本語 ${CHRONICLE_DETAIL_MAX_JA} 字以内 / 英語 ${CHRONICLE_DETAIL_MAX_EN} 字以内）。
* evidence は、その日の日記から**一字も変えずに抜き出した ${EVIDENCE_MIN_CHARS} 文字以上の連続した部分**。
  要約や言い換えを入れてはいけません。ここが合わないとその節目は捨てられます。
${TONE_RULES_JA}
`;
}

/**
 * 応答スキーマ。
 *
 * **date は実在する日記の日付だけの enum にする。** 文法拘束なので、存在しない日付を
 * 返すこと自体がデコード時点で不可能になる（プロンプトの禁止文は確率的にしか効かない）。
 * ニュースも同じ理由で候補の添字で選ばせ、見出しも URL も自由記述させない。
 */
export function chronicleMonthSchema(dates: string[]) {
  return {
    type: Type.OBJECT,
    properties: {
      highlights: {
        type: Type.ARRAY,
        maxItems: CHRONICLE_MAX_HIGHLIGHTS,
        description:
          "この月の節目。無理に埋めず、目印になるものだけ。0件でよい。",
        items: {
          type: Type.OBJECT,
          properties: {
            date: {
              type: Type.STRING,
              enum: dates,
              description: "その節目があった日。候補のいずれかちょうど1つ。",
            },
            titleJa: { type: Type.STRING, description: `日本語の見出し（${CHRONICLE_TITLE_MAX_JA}字以内）。` },
            titleEn: { type: Type.STRING, description: `titleJa と同じ内容の自然な英語（${CHRONICLE_TITLE_MAX_EN}字以内）。` },
            detailJa: { type: Type.STRING, description: `日本語のひとこと（${CHRONICLE_DETAIL_MAX_JA}字以内）。` },
            detailEn: { type: Type.STRING, description: `detailJa と同じ内容の自然な英語（${CHRONICLE_DETAIL_MAX_EN}字以内）。` },
            evidence: {
              type: Type.STRING,
              description: `その日の日記から一字も変えずに抜き出した ${EVIDENCE_MIN_CHARS} 文字以上の連続した部分。`,
            },
          },
          required: ["date", "titleJa", "titleEn", "detailJa", "detailEn", "evidence"],
          propertyOrdering: ["date", "titleJa", "titleEn", "detailJa", "detailEn", "evidence"],
        },
      },
    },
    required: ["highlights"],
    propertyOrdering: ["highlights"],
  };
}

/**
 * 呼び出し前の実測。予算を超えていたら呼び出し側が月を割る。
 * chronicleDiaryCap は見積もりで丸めるだけなので、最後にここで実際の文字列を測る。
 */
export function chronicleMonthFits(input: ChronicleMonthInput): boolean {
  const instruction = `${SYSTEM_INSTRUCTION}\n${buildChronicleMonthInstruction(input)}`;
  const material = buildChronicleMonthMaterial(input);
  const estimated = estimateMessagesTokens([
    { content: instruction },
    { content: material },
  ]);
  return (
    estimated <=
    ollamaPromptBudget({
      numCtx: ollamaTextContextLength(),
      outputTokens: 2048,
    })
  );
}

/** 応答を検証して、信用できるものだけ残す。 */
export function acceptChronicleMonth(
  input: ChronicleMonthInput,
  json: unknown,
): ChronicleMonthResult {
  const raw = (json ?? {}) as Record<string, unknown>;
  const byDate = new Map(input.diaries.map((d) => [d.date, d.text]));
  const seen = new Set<string>();
  const highlights: ChronicleHighlight[] = [];

  for (const item of Array.isArray(raw.highlights) ? raw.highlights : []) {
    if (highlights.length >= CHRONICLE_MAX_HIGHLIGHTS) break;
    const row = (item ?? {}) as Record<string, unknown>;
    const date = String(row.date ?? "");
    const diary = byDate.get(date);
    // enum で拘束しているが、拘束が効かないモデル/経路に差し替わったときのために見る。
    if (!diary || seen.has(date)) continue;

    // 逐語抜粋が本文に無ければ、その節目は作り話。**1件だけ捨てて続行する**
    // （throw にすると、1件の幻覚で月ごと落ちる）。
    try {
      validateChaosExcerpt(row.evidence, diary);
    } catch {
      continue;
    }

    const titleJa = clip(row.titleJa, CHRONICLE_TITLE_MAX_JA);
    const titleEn = clip(row.titleEn, CHRONICLE_TITLE_MAX_EN);
    if (!titleJa || !titleEn) continue;
    const detailJa = clip(row.detailJa, CHRONICLE_DETAIL_MAX_JA);
    const detailEn = clip(row.detailEn, CHRONICLE_DETAIL_MAX_EN);
    if ([titleJa, titleEn, detailJa, detailEn].some(rejectChronicleTone)) continue;

    seen.add(date);
    highlights.push({
      date,
      titleJa,
      titleEn,
      detailJa,
      detailEn,
      evidence: String(row.evidence).trim(),
    });
  }

  return { highlights };
}

export async function generateChronicleMonth(
  input: ChronicleMonthInput,
): Promise<ChronicleMonthResult> {
  if (!input.diaries.length) return { highlights: [] };

  const response = await generateContentWithRetry(
    {
      feature: "NAGI_CHRONICLE_MONTH",
      // 材料はこの1本だけ。指示は systemInstruction 側（fitOllamaMessages に削られない）。
      contents: [buildChronicleMonthMaterial(input)],
      // 投稿本文ではないので、投稿用の長さ制限を当てない。
      maxTextLength: null,
      config: {
        systemInstruction: `${SYSTEM_INSTRUCTION}\n${buildChronicleMonthInstruction(input)}`,
        responseMimeType: "application/json",
        responseSchema: chronicleMonthSchema(
          input.diaries.map((diary) => diary.date),
        ),
        // 0〜3件ぶん。明示しないと maxTextLength:null 側の 4096 が載り、
        // そのぶんプロンプト予算が無駄に狭くなる。
        maxOutputTokens: 2048,
        // 抽出寄りに下げる。0 にはしない（AGENTS.md: ペルソナの言い回しが毎回同じになる）。
        temperature: 0.4,
      },
    },
    3,
  );

  try {
    return acceptChronicleMonth(input, JSON.parse(response.text || "{}"));
  } catch (e) {
    console.error(
      "[ERROR] Failed to parse Structured Outputs JSON in generateChronicleMonth:",
      e,
    );
    return { highlights: [] };
  }
}
