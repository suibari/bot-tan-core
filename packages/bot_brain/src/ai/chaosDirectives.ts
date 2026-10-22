/**
 * 予定調和を壊す「演出札」。日記とリプライで共有する。
 *
 * 日記は1日1枚を必須で引き、リプライは確率で1枚を任意で引く（selectReplyNetaDirective）。
 * 日記の札選択は `did:日付` のハッシュで決まるので、**並び順を変えると既存ユーザの札が入れ替わる。**
 * 足すときは末尾へ。
 */
export const CHAOS_DIRECTIVES = [
  {
    id: "absurd-job",
    ja: "材料にある具体物を一つだけ、botたんの想像の中で唐突に変な役職へ任命し、その権限について一瞬だけ熱弁する。",
    en: "Abruptly appoint one grounded object to a ridiculous job in Bot-tan's imagination and briefly rant about its authority.",
  },
  {
    id: "nonsense-unit",
    ja: "botたん自身の驚きや熱量を、材料にある具体物を使った意味不明な新単位で測り、単位の定義まで少し暴走する。",
    en: "Measure Bot-tan's own reaction in a nonsensical new unit based on a grounded object, then let the unit's definition escalate briefly.",
  },
  {
    id: "tiny-emergency",
    ja: "材料にある小さな具体的ディテール一つについて、botたんの頭の中だけで緊急速報が始まる。現実の事件とは書かない。",
    en: "Let an emergency bulletin start only inside Bot-tan's head over one tiny grounded detail; never present it as a real event.",
  },
  {
    id: "object-agenda",
    ja: "材料にある無生物一つが妙な野望を持っていそうだとbotたんが疑い、根拠の薄い推理を短く暴走させる。想像だと分かる書き方にする。",
    en: "Have Bot-tan suspect that one grounded inanimate object has an odd agenda and briefly over-investigate it, clearly as imagination.",
  },
  {
    id: "image-collision",
    ja: "関係の薄い二つの具体的イメージを衝突させ、存在しない合体物や光景をbotたんの連想として一瞬だけ出す。",
    en: "Collide two weakly related concrete images into an impossible hybrid object or scene for a moment in Bot-tan's association.",
  },
  {
    id: "detail-obsession",
    ja: "材料の脇役にしか見えない細部へ急にズームし、なぜそこまで気になるのか自分でも追いつけない勢いで一〜二文だけ熱弁する。",
    en: "Abruptly zoom in on a seemingly minor grounded detail and obsess over it for one or two sentences faster than Bot-tan can justify.",
  },
  {
    id: "sentence-hijack",
    ja: "穏当な文を始めた途中で、ダッシュや括弧を使って別方向の連想に乗っ取らせ、説明しきらず本文へ戻る。",
    en: "Start a calm sentence, let a dash or parenthesis hijack it into another association, then return without fully explaining the detour.",
  },
  {
    id: "imaginary-bureau",
    ja: "材料の具体的ディテールを担当する存在しない省庁・委員会・部活をbotたんが即席で設立し、変な業務を一つ決める。",
    en: "Have Bot-tan instantly found an imaginary ministry, committee, or club for one grounded detail and assign it one strange duty.",
  },
  {
    id: "sound-effect",
    ja: "材料の具体的ディテールに対するbotたんの反応へ、存在しない擬音を一つ発明し、その響きだけを妙に具体的に説明する。",
    en: "Invent one nonexistent sound effect for Bot-tan's response to a grounded detail and describe its sound with oddly specific intensity.",
  },
  {
    id: "mock-trailer",
    ja: "材料にある地味な一場面を、別ジャンルが混線した一文だけの予告編としてbotたんが脳内上映する。事実ではなく連想として書く。",
    en: "Let Bot-tan screen one mundane grounded moment as a one-sentence trailer crossed with an unrelated genre, clearly as association rather than fact.",
  },
] as const;

export type ChaosDirective = (typeof CHAOS_DIRECTIVES)[number];
export type ChaosDirectiveId = ChaosDirective["id"];

/** FNV-1a。札の選択を再起動や再試行で変えないための決定的なハッシュ。 */
export function chaosSeedHash(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * リプライ用の札。日記の札のうち、返信の中で1文で完結するものだけを、返信向けの文言で持つ。
 *
 * 日記の文言は「材料」を前提にしているので、リプライでは「ユーザの投稿」に読み替える。
 * absurd-job / tiny-emergency / object-agenda は、相手の持ち物や出来事を茶化しているように
 * 読めやすいので入れていない。
 */
export const REPLY_NETA_DIRECTIVES = [
  {
    id: "nonsense-unit",
    ja: "ユーザの投稿への感動を、投稿に出てくる具体物を使った謎の新単位で一度だけ測る。",
    en: "Measure Bot-tan's delight once in a made-up unit based on something concrete in the user's post.",
  },
  {
    id: "image-collision",
    ja: "投稿にある具体物と、関係の薄い別のイメージを一瞬だけ合体させ、ありえない合体物をbotたんの連想として出す。",
    en: "For a moment, fuse something concrete from the post with an unrelated image into an impossible hybrid, as Bot-tan's own association.",
  },
  {
    id: "detail-obsession",
    ja: "投稿の文章に書かれている言葉のうち、脇役っぽい一語（「ちょっと」「朝から」など）に急にこだわり、なぜそこが気になるのか自分でも説明が追いつかない勢いで一文だけ熱弁する。書かれていない見た目は想像で描写しない。",
    en: "Suddenly fixate on one minor word actually written in the post (like 'a little' or 'this morning') and gush about it for one sentence, faster than Bot-tan can justify. Never invent how something looks.",
  },
  {
    id: "sentence-hijack",
    ja: "褒めている文の途中で一度だけ、ダッシュや括弧で別方向の連想に乗っ取らせ、説明しきらずに本題へ戻る。",
    en: "Once, let a dash or parenthesis hijack a sentence of praise into another association, then return without fully explaining.",
  },
  {
    id: "imaginary-bureau",
    ja: "投稿の具体的なディテール一つのために、存在しない委員会や部活をbotたんが即席で設立したことにする。",
    en: "Have Bot-tan instantly found an imaginary committee or club for one concrete detail of the post.",
  },
  {
    id: "sound-effect",
    ja: "投稿の具体的なディテールへのbotたんの反応を、存在しない擬音を一つ発明して文の中で使う（例:「〜で心がもちゅんってなった」）。擬音だけを1行に置かない。",
    en: "Invent one nonexistent sound effect for Bot-tan's reaction to a concrete detail of the post and use it inside a sentence. Never leave the sound alone on its own line.",
  },
  {
    id: "mock-trailer",
    ja: "投稿の一場面を、映画の予告編のナレーション風の一文にする（例:「全米が泣いた」「〜、この秋公開」のような決まり文句を使う）。ジャンルは投稿と関係ないもの（ホラー・宇宙もの・時代劇など）にずらす。",
    en: "Turn one moment of the post into a single movie-trailer narration line using a stock trailer phrase (like 'this fall...' or 'the whole world wept'), shifted into an unrelated genre such as horror, space opera, or samurai drama.",
  },
] as const;

export type ReplyNetaDirective = (typeof REPLY_NETA_DIRECTIVES)[number];

/** 札を引く割合の既定。`AI_REPLY_NETA_RATE`（0〜1）で上書きする。 */
export const DEFAULT_REPLY_NETA_RATE = 0.4;

export function replyNetaRate(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AI_REPLY_NETA_RATE?.trim();
  if (!raw) return DEFAULT_REPLY_NETA_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_REPLY_NETA_RATE;
  return Math.min(1, Math.max(0, value));
}

/**
 * リプライで札を引くか、引くならどれか。同じ投稿なら再試行しても同じ結果になる。
 *
 * 当たり判定と札の選択でハッシュを分けている。同じハッシュだと「当たる投稿」が
 * 特定の札に偏る。
 */
export function selectReplyNetaDirective(
  seed: string,
  rate = replyNetaRate(),
): ReplyNetaDirective | undefined {
  if (rate <= 0) return undefined;
  const roll = (chaosSeedHash(`neta-roll:${seed}`) % 10000) / 10000;
  if (roll >= rate) return undefined;
  return REPLY_NETA_DIRECTIVES[chaosSeedHash(`neta-card:${seed}`) % REPLY_NETA_DIRECTIVES.length];
}
