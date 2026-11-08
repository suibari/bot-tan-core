import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import {
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
} from "@bsky-affirmative-bot/shared-configs";

/** アドカレの候補ポスト1件。サーバがくじと条件で数人ぶんに絞ってから渡す。 */
export interface AdventPickCandidateView {
  displayName: string;
  /** "YYYY-MM-DD"（JST）。季節感の取り違えを防ぐために添える。 */
  date: string;
  text: string;
}

export interface AdventPickInput {
  /** 1〜25。 */
  day: number;
  candidates: AdventPickCandidateView[];
}

export interface AdventPickResult {
  /** 選んだ候補の番号（1始まり）。0 は選べなかった。 */
  pick: number;
  /**
   * モデルが「どれも載せられない」と判断した。呼び出し側はこの回の候補を、その年は
   * もう候補にしない（見せ直すたびに判断が揺れ、いつか通ってしまうため）。
   * 選んだが文面が書けなかっただけのときは false。
   */
  rejectedAll: boolean;
  titleJa: string;
  titleEn: string;
  commentJa: string;
  commentEn: string;
}

export type AdventCardText = Omit<AdventPickResult, "pick" | "rejectedAll">;

/**
 * v2: 「選ぶ」と「書く」を分けた（12B が1回で両方をこなせず、欄の中身が入れ替わったため）。
 * v3: プレゼントなので見出しはモノを優先する。
 *     （補足文も試したが、外の知識で書かせると取り違えが出たので入れない。
 *      2026-11-08 に「Scar」をライオン・ガードのスカーと書いた。見出しと一言はポストの中身だけで書く）
 */
export const NAGI_ADVENT_PICK_PROMPT_VERSION = "nagi-advent-pick-v3";

export const ADVENT_TITLE_MAX = 24;
export const ADVENT_COMMENT_MAX = 70;
/** 文面が検査に通らなかったときに書き直させる回数。 */
const TEXT_ATTEMPTS = 3;

const flat = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * アドカレのカードを1枚選び、見出しと一言を書く。
 *
 * **選ぶのと書くのを別の呼び出しにしてある。** 2026-11-08 に本番データで試したところ、
 * Gemma 12B に十数件から選ばせつつ見出しと一言を日英で書かせると、見出し欄に一言の
 * 書きかけが入る・一言欄に「選んだポスト：12. …」と作業メモが入る、と欄が崩れた。
 *
 * **「載せない」を選べるようにしてある（pick=0）。** どれも合わないときに無理に
 * 選ばせると、それがみんなに配られてしまうので、呼び出し側は次の候補群で選び直す。
 * 文面が書き直しても検査に通らないときも 0 を返す。
 */
export async function generateAdventPick(
  input: AdventPickInput,
): Promise<AdventPickResult> {
  const empty = { titleJa: "", titleEn: "", commentJa: "", commentEn: "" };
  const pick = await chooseAdventCandidate(input);
  const chosen = input.candidates[pick - 1];
  if (!chosen) return { pick: 0, rejectedAll: true, ...empty };
  for (let attempt = 0; attempt < TEXT_ATTEMPTS; attempt += 1) {
    const text = await writeAdventCardText(input.day, chosen);
    if (text && !adventCardTextProblem(text, chosen.displayName))
      return { pick, rejectedAll: false, ...text };
  }
  return { pick: 0, rejectedAll: false, ...empty };
}

/** 候補から1件の番号を選ぶ。0 はどれも載せられない。 */
async function chooseAdventCandidate(input: AdventPickInput): Promise<number> {
  const response = await generateContentWithRetry(
    {
      feature: "NAGI_ADVENT_PICK",
      // 指示が先、ユーザーのポストは最後（AGENTS.md「プロンプトの並び順」）。
      contents: [buildAdventPickInstruction(input), buildAdventPickCandidates(input)],
      maxTextLength: null,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            // 先に短く理由を書かせてから番号を出させる（いきなり番号だと読まずに選びやすい）。
            reason: {
              type: Type.STRING,
              description: "選んだ理由、または全部を選ばない理由（日本語・40文字以内）。",
            },
            pick: {
              type: Type.INTEGER,
              description: `選んだポストの番号（1〜${input.candidates.length}）。載せられるものが1つもなければ 0。`,
            },
          },
          required: ["reason", "pick"],
          propertyOrdering: ["reason", "pick"],
        },
      },
    },
    3,
  );
  try {
    const pick = Number((JSON.parse(response.text || "{}") as { pick?: unknown }).pick);
    return Number.isInteger(pick) && pick >= 1 && pick <= input.candidates.length ? pick : 0;
  } catch (e) {
    console.error("[ERROR] Failed to parse advent pick JSON:", e);
    return 0;
  }
}

/** 選んだ1件の見出しと一言を書く。形が壊れていれば undefined。 */
async function writeAdventCardText(
  day: number,
  candidate: AdventPickCandidateView,
): Promise<AdventCardText | undefined> {
  const response = await generateContentWithRetry(
    {
      feature: "NAGI_ADVENT_PICK",
      // 指示が先、ユーザーの投稿は最後（AGENTS.md「プロンプトの並び順」）。
      contents: [buildAdventTextInstruction(day), buildAdventTextPost(candidate)],
      maxTextLength: null,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            titleJa: {
              type: Type.STRING,
              description: `見出し。プレゼントにする「モノ」の名前（なければ出来事）の日本語の名詞句だけ（${ADVENT_TITLE_MAX}文字以内）。`,
            },
            commentJa: {
              type: Type.STRING,
              description: `botたんの一言（日本語・1〜2文・${ADVENT_COMMENT_MAX}文字以内）。`,
            },
            titleEn: { type: Type.STRING, description: "titleJa の英訳（名詞句）。" },
            commentEn: { type: Type.STRING, description: "commentJa の英訳。" },
          },
          required: ["titleJa", "commentJa", "titleEn", "commentEn"],
          propertyOrdering: ["titleJa", "commentJa", "titleEn", "commentEn"],
        },
      },
    },
    3,
  );
  try {
    const json = JSON.parse(response.text || "{}") as Record<string, unknown>;
    return {
      titleJa: flat(json.titleJa).replace(/^[「『"]|[」』"]$/g, ""),
      commentJa: flat(json.commentJa),
      titleEn: flat(json.titleEn).replace(/^["“]|["”]$/g, ""),
      commentEn: flat(json.commentEn),
    };
  } catch (e) {
    console.error("[ERROR] Failed to parse advent card text JSON:", e);
    return undefined;
  }
}

/** 作業メモや欄の名前が本文に漏れた形。 */
const META_PATTERN = /選んだ|見出し|一言|ポスト[:：]|候補|番号|pick|title|comment/i;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;

/**
 * カードに載せられない文面なら理由を返す。通れば undefined。
 * 構造が正しくても中身が入れ違う事故は、こうして中身を見ないと気付けない。
 */
export function adventCardTextProblem(
  text: AdventCardText,
  displayName: string,
): string | undefined {
  const { titleJa, commentJa, titleEn, commentEn } = text;
  if (titleJa.length < 2 || titleJa.length > ADVENT_TITLE_MAX) return "title length";
  if (commentJa.length < 8 || commentJa.length > ADVENT_COMMENT_MAX + 10) return "comment length";
  if (META_PATTERN.test(titleJa) || META_PATTERN.test(commentJa)) return "meta leaked";
  if (/[。！？!?]$/.test(titleJa) && titleJa.length > 12) return "title is a sentence";
  const name = displayName.trim();
  if (name && name.length >= 2 && titleJa.includes(name)) return "name in title";
  if (commentJa === titleJa || commentJa.startsWith(titleJa)) return "comment repeats title";
  if (!KANA.test(commentJa)) return "comment not japanese";
  if (!titleEn || !commentEn) return "english missing";
  if ((`${titleEn}${commentEn}`.match(JAPANESE) ?? []).length > 2) return "english has japanese";
  if (titleEn.length > 70 || commentEn.length > 200) return "english length";
  return undefined;
}

export const buildAdventPickInstruction = (input: AdventPickInput): string =>
  `あなた（botたん）は、Nagi のアドベントカレンダーの ${input.day} 日目のカードにするポストを選びます。
Nagi のみんなの今年のポストの中から、嬉しい「もの」や「できごと」が伝わるものをひとつ選んで、
**Nagi ユーザーみんなへのプレゼントカード**にします。選んだ人の名前とアバターも一緒に、みんなに公開されます。
ここでは**番号を選ぶだけ**です。カードの文面はあとで別に書きます。

# 選ぶもの
* 喜び・達成・好きなもの・楽しかったできごとが、**具体的に**伝わってくるポスト。
* **プレゼントなので、うれしい「モノ」がはっきり出てくるポストを優先する。**
  （例: 買えたプラモデル、焼けたメロンパン、もらった推しのグッズ、届いた本）
  モノが出てくるポストが無いときだけ、出来事のポストを選ぶ（例: 資格に合格した、ライブに行けた）。
* 読んだ人までうれしくなるもの。

# 選ばないもの（当てはまるものしかなければ pick を 0 にする）
* 「おはよう」「おやすみ」「ただいま」などの挨拶だけ、内容がほとんどないもの。
* 誰かの悪口・愚痴が主なもの、喜びが皮肉や冗談の形になっているもの。
* センシティブなもの（性的な話題、病気や障がい・体の不調、お金の具体額、家族や他人の私生活、
  住所・勤務先・本名など個人が分かる情報）、そのほか公開の場に出すと本人が困りそうなもの。
* まだ起きていない予定や願望だけのもの（「合格したい」は選ばない。「合格した」は選ぶ）。
* botたん（あなた）へのお礼やあなたの話題が中心のもの。みんなへのプレゼントにならない。`;

export const buildAdventPickCandidates = (input: AdventPickInput): string => {
  const list = input.candidates
    .map((c, index) => `${index + 1}. ${c.displayName}（${c.date}）\n${c.text}`)
    .join("\n-----\n");
  return `# 候補のポスト（この中から1つ。どれも合わなければ 0）
-----
${list}
`;
};

export const buildAdventTextInstruction = (day: number): string =>
  `あなた（botたん）は、Nagi のアドベントカレンダー ${day} 日目のクリスマスカードを書きます。
最後に渡すポストの嬉しい「モノ」（なければ出来事）を、Nagi のみんなへのプレゼントとして紹介するカードです。

# titleJa（見出し）
* **プレゼントなので、ポストに出てくるうれしい「モノ」の名前を見出しにする。**
  買った・もらった・作った・食べた、という行為は付けず、モノそのものにする。
  （「MGSDデスティニーの購入」ではなく「MGSDデスティニー」。「メロンパンが焼けた」ではなく「焼きたてのメロンパン」）
* モノが出てこないポストのときだけ、出来事を短い名詞句にする（例: 「推しのライブ当選」「資格試験の合格」）。
* 文にしない。人名・個人が分かる情報は入れない。**ポストにないことを足さない。**

# commentJa（botたんの一言）
* その嬉しさを一緒に喜び、みんなにおすそわけする気持ちで1〜2文。名前を呼ぶときは「〇〇さん」。
* 行為の主体と時制を取り違えない（家族がしたことを本人の手柄にしない、未完了を完了として祝わない）。
* ポストに書かれていないこと（そのモノや作品が何なのかの説明・知識）を足さない。
* ポストの文章をそのまま長く写さない。見出しを繰り返さない。
${TONE_RULES_JA}

# titleEn / commentEn
* それぞれ titleJa / commentJa の自然な英訳。日本語を混ぜない。`;

export const buildAdventTextPost = (candidate: AdventPickCandidateView): string =>
  `# カードにするポスト（${candidate.displayName}さん・${candidate.date}）
-----
${candidate.text}
`;
