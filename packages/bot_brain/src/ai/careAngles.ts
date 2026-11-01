import { chaosSeedHash } from './chaosDirectives.js';

/**
 * 落ち込んだ投稿へのリプライで使う「寄り添いの角度」。
 *
 * 以前は CARE_TOPIC_RULES が「お礼・受け止め・そばにいる」の3点を中心に据えるよう指定し、
 * 卑下や悩みには「よく考えていてえらいね」「そういう時もあるよね」と例文まで渡していた。
 * 26B / 12B は例文と指定をそのまま写すので、落ち込んだ投稿への返信が毎回
 * 「共感 → 無理しないで → 一緒にいるよ」の同じ形になっていた。
 *
 * 言い方の候補を並べてモデルに選ばせても、モデルは毎回同じ候補を選ぶ。なので演出札
 * （chaosDirectives の REPLY_NETA_DIRECTIVES）と同じく、**どの角度で返すかはコードが決める**。
 *
 * どの角度も、投稿に書いてあることだけで書けるものに絞っている（カウンセリングの
 * 基本技法から、単発のリプライで使えるものだけ取った）。「解決策」は事情を知らないと
 * 書けず、過去の「わたしも」事故と同じく事情の捏造に流れるので、軽い落ち込みに限って
 * 「落ち込んだままでできる小さなこと」（森田療法の目的本位）の形でだけ許す。
 *
 * tier:
 * - light … 気分 -1〜-2（疲れ・がっかり・日常のつまずき）
 * - heavy … 気分 -3 以下。CARE_TOPIC_RULES の「助言しない・分析して評価しない」と
 *           ぶつかる角度（small-step / already-doing）は入れない。
 */
export type CareTier = 'light' | 'heavy';

export const CARE_ANGLES = [
  {
    // 感情の反映
    id: 'name-feeling',
    tiers: ['light', 'heavy'],
    ja: 'ユーザが書いた気持ちの言葉を1つだけ拾い、その気持ちになるのは自然なことだと受け止める。出来事は並べ直さない。気持ちの言葉が書かれていなければ、気持ちを推測して名付けない。',
    en: 'Pick up just one feeling word the user actually wrote, and receive it as a natural thing to feel. Do not restate the events. If no feeling word is written, do not guess one.',
  },
  {
    // ソリューション・フォーカスト・アプローチの「例外探し」
    id: 'already-doing',
    tiers: ['light'],
    ja: '投稿に書かれている、ユーザがすでにしている行動や選んだことを1つ見つけて、それを肯定する。書かれていない頑張りや成果を作らない。',
    en: 'Find one action or choice the user has already made that is written in the post, and affirm it. Never invent effort or results that are not written.',
  },
  {
    // 森田療法の「あるがまま」と目的本位
    id: 'small-step',
    tiers: ['light'],
    ja: '気分を変えようとはせず、落ち込んだままでもできそうな小さなことを1つだけ、「〜してもいいかも」のように選べる形でそっと添える。投稿に書かれた状況の範囲で考え、商品名・固有名・数字、医療・薬・お金・法律・仕事の進め方についての助言は入れない。',
    en: 'Without trying to change their mood, gently offer just one small thing they could do even while feeling low, as an option ("maybe you could..."). Stay within the situation the post describes. No product names, proper nouns, or numbers, and no advice about health, medicine, money, law, or how to do their job.',
  },
  {
    id: 'close-today',
    tiers: ['light', 'heavy'],
    ja: '今日はもうここで区切っていい、続きは今日決めなくていい、という時間の区切りを差し出す。',
    en: 'Offer a pause in time: it is fine to close today here, and nothing has to be decided today.',
  },
  {
    // 意味の反映
    id: 'what-mattered',
    tiers: ['light', 'heavy'],
    ja: 'つらさの裏にある、ユーザが大事にしているもの（投稿に書かれている願いや価値）を映し返す。投稿に書かれていない内面や動機は足さない。',
    en: 'Reflect back what the user cares about behind the pain — a wish or value written in the post. Do not add inner motives that are not written.',
  },
  {
    // 開いた質問
    id: 'open-question',
    tiers: ['light', 'heavy'],
    ja: '受け止めたあと、答えなくてもいい開いた問いを1つだけ置く（「答えなくて大丈夫」と分かる形で）。原因や事情を決めつけて聞かない。',
    en: 'After receiving them, leave one open question they do not have to answer (make it clear that no answer is needed). Never assume the cause in the question.',
  },
  {
    // 受容。従来の型。消さずに選択肢の1つとして残す。
    id: 'stay-close',
    tiers: ['light', 'heavy'],
    ja: 'いまの状態のままでいいと受け止め、botたんが静かにそばにいることを伝える。',
    en: 'Accept them as they are right now, and let them know Bot-tan is quietly here with them.',
  },
] as const;

export type CareAngle = (typeof CARE_ANGLES)[number];
export type CareAngleId = CareAngle['id'];

/** 気分（scorePostMood の valence）から tier を決める。沈んでいなければ undefined。 */
export function careTierForValence(valence: number): CareTier | undefined {
  if (valence >= 0) return undefined;
  return valence >= -2 ? 'light' : 'heavy';
}

export function careAnglesForTier(tier: CareTier): CareAngle[] {
  return CARE_ANGLES.filter((angle) => (angle.tiers as readonly CareTier[]).includes(tier));
}

/** 同じ投稿なら再試行しても同じ角度になる（演出札と同じ決定的ハッシュ）。 */
export function selectCareAngle(seed: string, tier: CareTier): CareAngle {
  const angles = careAnglesForTier(tier);
  return angles[chaosSeedHash(`care-angle:${tier}:${seed}`) % angles.length];
}
