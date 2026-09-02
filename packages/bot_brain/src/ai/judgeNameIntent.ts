import { Type } from "@google/genai";
import { generateContentForFeature } from "./routedGeneration.js";

/**
 * botたん宛リプライから「本人が自分をどう呼んでほしいか」だけを抜き出す判定。
 *
 * 背景: displayName から LLM が勝手に愛称を作って呼称がブレる事故があった。
 * Phase 1 で displayName 固定にしてブレは止めたが、本人が別の呼び名を希望しても
 * 反映できない。ここはその希望を拾うための入口。
 *
 * ## モデル移行時の注意
 *
 * 過去に実データ39件を旧gemma3:4bで測ったところ、誤爆率が
 * プロンプトを触るたび 0% ↔ 2.6% を行き来し、検出は 84.6% で頭打ちだった。
 * 特に、獲得した称号の話のような **本人が持ってはいるが呼びかけには使わない名前** を
 * self と判定してしまう。誤爆すると botたんがその文字列で相手を呼び始めるので、
 * 実害は見逃しより大きい。
 *
 * ## なぜ返信生成とは別リクエストか
 *
 * conversation は googleSearch / urlContext を使うため responseSchema と排他になる
 * （util.ts の `// Removed due to conflict with Google Search` と同じ制約）。
 * 判定を返信生成に相乗りさせるとプロンプト指示の JSON しか使えず、
 * パース失敗時に JSON がそのまま投稿される経路ができてしまう。
 * こちらは grounding を使わないので responseSchema で構造を保証できる。
 * 判定は本文生成と別リクエストにし、現在は共通のOllamaモデルをJSON Schema付きで使う。
 *
 * 返信生成と**並列**に走らせる。判定結果は次回以降の返信に効き、
 * その場の返信は会話プロンプトの「訂正には従う」が担う。
 */

export type NameIntent = "rename_request" | "correction" | "none";

export type NameIntentResult = {
  intent: NameIntent;
  /** 本人が呼ばれたい名前。intent が none のときは null。 */
  name: string | null;
  confidence: number;
};

const NONE: NameIntentResult = { intent: "none", name: null, confidence: 0 };

/** これ未満の確信度は none に倒す。 */
export const NAME_INTENT_MIN_CONFIDENCE = 0.7;

/** 呼び名として受け付ける最大長。長い文字列は文を切り出した誤爆の可能性が高い。 */
const MAX_NAME_LENGTH = 40;

/**
 * 名前そのものではなく、名前の「種類」を指す語。これが name に入ってきたら捨てる。
 * 実測で「名字じゃなくて下の名前で呼んでほしいな」→ name="下の名前" が出た。
 */
const NAME_TYPE_WORDS =
  /^(下の名前|名字|苗字|名前|本名|あだ名|あだな|ニックネーム|ハンドルネーム|ハンドル|呼び名|first name|last name|family name|given name|full name|real name|nickname|handle|username)$/i;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    subject: { type: Type.STRING },
    intent: { type: Type.STRING },
    name: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  required: ["subject", "intent", "confidence"],
  propertyOrdering: ["subject", "intent", "name", "confidence"],
};

/**
 * ペルソナ（SYSTEM_INSTRUCTION）は載せない。これは判定であって発話ではないので、
 * 口調ルールを入れても判定精度には効かず、プロンプトが薄まるだけ。
 * ニュース審査の判定パスにペルソナを入れていないのと同じ理由。
 *
 * `subject`（その名前は誰・何のものか）を先に答えさせるのが要点。intent だけを聞くと、
 * 「名前が訂正された」ことは拾えても**誰の名前かを確かめない**。帰属先を明示的な
 * 出力にしておくと、self 以外を後段で機械的に弾ける。
 */
export const NAME_INTENT_PROMPT = (text: string) =>
  `SNSボット「botたん」への返信を読み、「返信を書いた人が、自分自身をどう呼んでほしいかを
伝えているか」だけを判定してください。

まず subject（文中に出てくる名前が誰・何のものか）を決め、その後に intent を決めます。

subject の候補:
- self       : 返信を書いた本人への呼びかけに使う名前
- bot        : 相手（botたん）の名前
- other      : 他の人の名前
- pet        : ペットや動物の名前
- work       : 作品・ゲーム・曲・商品などのタイトル、および作品の登場人物
- place      : 店・地名などの名前
- title      : 称号・バッジ・肩書き・実績の名前
- other_thing: 上記以外のもの（アイコン、アカウント、ファイル名など）
- na         : 名前の話が出てこない

**subject が self でなければ intent は必ず none です。**
「〜じゃなくて」「ちゃう」「違う」「間違ってる」といった訂正の言葉があっても、
訂正の対象が本人への呼びかけでなければ none にしてください。

**self は「本人をどう呼びかけるか」だけです。**
本人が持っているものでも、呼びかけに使う名前でなければ self ではありません。
称号・バッジ・肩書き・実績名は、「わたしの称号」「僕のバッジ」のように本人のものとして
語られていても subject=title です。アイコン・アカウント・持ち物の名前も self ではありません。

intent の候補:
- rename_request: 自分の呼び名を新しく指定している
- correction    : 自分の呼び名を間違われたことを指摘・訂正している
- none          : 上記以外すべて

アニメ・マンガ・ゲーム・小説の登場人物やキャラクターの名前は、本人が話題にしていても
subject=work です。本人以外を指す名前は self になりません。

name には、**実際にその人を呼ぶときに使う文字列だけ**を短く入れてください。
「下の名前」「名字」「あだ名」「ハンドルネーム」「本名」のような、名前の**種類**を指す語は
名前ではありません。呼び名の指定はあるがその名前自体が書かれていない場合は、
必ず name を null にしてください。文をそのまま入れないこと。
confidence は 0〜1 の確信度です。

-----ここから判定対象の返信-----
${text}`;

/**
 * 応答の正規化。responseSchema で形は保証されるが、意味の妥当性は別なので
 * ここで機械的に弾く。少しでも怪しければ none に倒す
 * （誤爆の実害が見逃しより大きいため）。
 */
export function normalizeNameIntent(parsed: unknown): NameIntentResult {
  const value = parsed as any;
  const intent = value?.intent;
  if (intent !== "rename_request" && intent !== "correction") return NONE;

  // モデルが自己申告した帰属先で弾く。intent だけを信じると、猫の名前や
  // ゲーム名、本人の称号の訂正が「本人の改名依頼」として通ってしまう。
  if (value?.subject !== "self") return NONE;

  const confidence =
    typeof value?.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.min(Math.max(value.confidence, 0), 1)
      : 0;
  if (confidence < NAME_INTENT_MIN_CONFIDENCE) return NONE;

  const name = typeof value?.name === "string" ? value.name.trim() : "";
  // 名前が取れない correction（「名前間違ってるよ」だけ等）は保存しようがないので
  // none と同じ扱いにする。その場の追従は会話プロンプトの「訂正には従う」に任せる。
  if (!name || name.length > MAX_NAME_LENGTH) return NONE;
  // null 許容のスキーマでも、モデルは文字列の "null" を返すことがある。
  // そのまま通すと botたんが相手を「null」と呼び始める。
  if (/^(null|none|undefined|n\/a|なし)$/i.test(name)) return NONE;
  // 名前の「種類」を指す語を名前として抜いてくることがある
  // （「名字じゃなくて下の名前で呼んで」→ name="下の名前"）。
  // プロンプトでも禁じているが、これを取り違えると相手を「下の名前」と呼び始めるので、
  // コード側でも弾く。
  if (NAME_TYPE_WORDS.test(name)) return NONE;
  // 改行を含むのは文を切り出した誤爆。
  if (/[\r\n]/.test(name)) return NONE;

  return { intent, name, confidence };
}

/**
 * 判定本体。失敗はすべて none を返す（呼び名が更新されないだけで、返信生成は続く）。
 */
export async function judgeNameIntent(text: string): Promise<NameIntentResult> {
  const trimmed = text?.trim();
  if (!trimmed) return NONE;
  try {
    const response = await generateContentForFeature(
      "NAGI_NAME_INTENT",
      {
        contents: [NAME_INTENT_PROMPT(trimmed)],
        config: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      },
    );
    return normalizeNameIntent(JSON.parse(response.text || "null"));
  } catch (error) {
    console.warn("[WARN][NAME_INTENT] judge failed, treating as none:", error);
    return NONE;
  }
}
