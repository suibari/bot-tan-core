import {
  CARD_RARITIES,
  dayIndexOfDateKey,
  type CardRarity,
} from "./cards.js";

/**
 * ゼンカツ！の回転設計（おやすみ＝クールタイムと提出枚数）。
 * 数字の根拠と実測は docs/zenkatsu.md の3章。
 */

/**
 * 一度出した札がおやすみする日数。レアリティが上がるほど長い。
 *
 * 排出率とおやすみ日数が逆相関しているので在庫が自然に釣り合う。N は勝手に貯まるから
 * 毎日回せるが、UR は持っていても週1しか出せない。「レアを持っている人が毎日有利」に
 * ならないのがこの並びの狙い。
 *
 * 実測（供給1.5枚/日・90日）では、**持っている最高レアの札を出せる日が 100% → 約25%** になる。
 * おやすみが無いと「持っている最強の3枚を永久に出し続ける」ゲームになり、卓が固定化する。
 */
export const ZENKATSU_REST_DAYS: Record<CardRarity, number> = {
  N: 2,
  R: 3,
  SR: 4,
  UR: 6,
  AAR: 7,
};

/** 在庫を引くときに遡る日数。いちばん長いおやすみ（AAR）より前は必ず戻っている。 */
export const ZENKATSU_MAX_REST_DAYS = Math.max(
  ...CARD_RARITIES.map((r) => ZENKATSU_REST_DAYS[r]),
);

/**
 * 1回に出せる最大枚数。**下限は無い**（1枚でもよい）。
 *
 * 3枚固定にすると序盤に詰む。必要在庫は `枚数 ×（おやすみ + 1）` なので常時12枚前後が要るが、
 * 供給は1日最大2枚しかない。可変にすると、出せる枚数が 1→2→3 と増える過程が
 * そのまま進行度の可視化になる。
 */
export const ZENKATSU_MAX_CARDS = 3;

/** 所持している札1種。 */
export interface ZenkatsuHolding {
  volume: number;
  id: number;
  rarity: CardRarity;
  /** 所持枚数（card_instances.duplicate_count）。同じ札を引き直すと増える。 */
  stock: number;
}

/** 過去の提出で出した札1枚。 */
export interface ZenkatsuPlay {
  volume: number;
  id: number;
  /** その提出のお題日付（"YYYY-MM-DD"）。 */
  themeDate: string;
}

/** 今日その札を何枚出せるか。 */
export interface ZenkatsuAvailability {
  volume: number;
  id: number;
  /** 在庫のうち、今日出せる枚数。0 なら全部おやすみ中。 */
  available: number;
  /** available が 0 のとき、いちばん早く戻る1枚があと何日でおきるか。 */
  restingDays?: number;
}

const cardKeyOf = (c: { volume: number; id: number }) => `${c.volume}:${c.id}`;

/**
 * 在庫とおやすみから、今日出せる枚数を出す。
 *
 * 「同じ札を複数枚持っていれば、そのぶん別の1枚として使える」が要点で、これによって
 * `duplicate_count` が初めて意味を持つ（＝ガチャで被っても嬉しい）。
 *
 *     出せる = 所持枚数 − （おやすみ日数以内にその札を出した回数）
 *
 * 日付キーの差だけで数えるので、時刻もタイムゾーンも混ざらない。
 *
 * @param today 今日の日付キー（cardDrawDate と同じ JST 4:00 境界）
 */
export function zenkatsuAvailability(
  holdings: readonly ZenkatsuHolding[],
  recentPlays: readonly ZenkatsuPlay[],
  today: string,
): ZenkatsuAvailability[] {
  const todayIndex = dayIndexOfDateKey(today);
  // 札ごとに「おやすみが明ける日」を集める。
  const restingUntil = new Map<string, number[]>();
  for (const play of recentPlays) {
    const key = cardKeyOf(play);
    const list = restingUntil.get(key);
    const playedIndex = dayIndexOfDateKey(play.themeDate);
    if (list) list.push(playedIndex);
    else restingUntil.set(key, [playedIndex]);
  }

  return holdings.map((holding) => {
    const rest = ZENKATSU_REST_DAYS[holding.rarity];
    const played = restingUntil.get(cardKeyOf(holding)) ?? [];
    // 出した日から rest 日ぶんはおやすみ。rest + 1 日目に戻る。
    // 未来日付（レコードを遡って書かれた場合）は数に入れない。
    const resting = played.filter(
      (playedIndex) =>
        playedIndex <= todayIndex && todayIndex - playedIndex <= rest,
    );
    const available = Math.max(0, holding.stock - resting.length);
    if (available > 0)
      return { volume: holding.volume, id: holding.id, available };
    // いちばん古い（＝いちばん早く明ける）1枚を見る。
    const earliest = Math.min(...resting);
    return {
      volume: holding.volume,
      id: holding.id,
      available: 0,
      restingDays: earliest + rest + 1 - todayIndex,
    };
  });
}

/** 遡って引くべき最古の日付キー。クールタイム判定で使う範囲の下限。 */
export function zenkatsuRestWindowStart(today: string): string {
  const start = (dayIndexOfDateKey(today) - ZENKATSU_MAX_REST_DAYS) * 86_400_000;
  return new Date(start).toISOString().slice(0, 10);
}

/** 提出しようとしている札の組が、形として妥当か（所持とおやすみは別途照合する）。 */
export function isValidZenkatsuSelection(
  cards: readonly { volume: number; id: number }[],
): boolean {
  if (!Array.isArray(cards)) return false;
  if (cards.length < 1 || cards.length > ZENKATSU_MAX_CARDS) return false;
  for (const card of cards) {
    if (!Number.isInteger(card.volume) || card.volume < 0) return false;
    if (!Number.isInteger(card.id) || card.id < 1) return false;
  }
  // 同じ日に同じ札は1枚まで（在庫が3枚あっても別カード3枚が要る）。種類を集める動機を残すため。
  return new Set(cards.map(cardKeyOf)).size === cards.length;
}

/**
 * 提出の「読み」。**モデルに算術をさせないため**、サーバ側で判定して日本語ラベルにする。
 *
 * 量子化モデルは ATK 合計のような計算を平気で間違える。計算済みの結論だけを渡し、
 * モデルには読み解きと言葉選びだけをさせる。
 *
 * 保存もする（zenkatsu_submissions.reading）。プロンプト用に作ったものを、
 * ニュースの選別（highlight）でも使い回すため。
 */
export interface ZenkatsuReadingCard {
  nameJa: string;
  rarity: CardRarity;
  attribute: string;
  raceJa: string;
  atk: number;
  def: number;
  /** その札を何枚持っているか（duplicate_count）。 */
  stock: number;
  /** この札をゼンカツに出すのが初めてか。 */
  firstPlay: boolean;
}

export interface ZenkatsuReading {
  /** プロンプトへ渡す箇条書き。表示には使わない（スコアを見せない設計のため）。 */
  labels: string[];
  /** ニュースタブに載せるか。 */
  highlight: boolean;
}

/** ニュースに載せる価値のあるレアリティ。 */
const HIGHLIGHT_RARITIES = new Set<CardRarity>(["UR", "AAR"]);

export function buildZenkatsuReading(
  theme: { attribute: string; raceJa?: string },
  cards: readonly ZenkatsuReadingCard[],
  combos: readonly { nameJa: string; bonus: number }[] = [],
): ZenkatsuReading {
  const labels: string[] = [];
  let highlight = false;

  const tailwind = cards.filter((c) => c.attribute === theme.attribute);
  labels.push(
    tailwind.length
      ? `追い風: ${tailwind.length}枚（${tailwind.map((c) => c.nameJa).join("、")}・${theme.attribute}属性）`
      : `追い風: なし（今日の追い風は ${theme.attribute} 属性）`,
  );
  // 全部が追い風なら、狙って揃えている。
  if (tailwind.length === cards.length && cards.length >= 2) highlight = true;

  if (theme.raceJa) {
    const hit = cards.filter((c) => c.raceJa === theme.raceJa);
    if (hit.length)
      labels.push(
        `お題の種族と同じ: ${hit.length}枚（${hit.map((c) => c.nameJa).join("、")}・${theme.raceJa}）`,
      );
  }

  const atk = cards.reduce((sum, c) => sum + c.atk, 0);
  const def = cards.reduce((sum, c) => sum + c.def, 0);
  const lean =
    def > atk * 1.2 ? "守り寄り" : atk > def * 1.2 ? "攻め寄り" : "ほぼ互角";
  labels.push(`編成の傾向: ${lean}（ATK合計${atk} / DEF合計${def}）`);

  // 同じ種族が2枚以上あれば、揃えたことに意味がある。
  const raceCounts = new Map<string, number>();
  for (const card of cards)
    raceCounts.set(card.raceJa, (raceCounts.get(card.raceJa) ?? 0) + 1);
  const paired = [...raceCounts].filter(([, n]) => n >= 2);
  if (paired.length)
    labels.push(
      `種族が揃った: ${paired.map(([race, n]) => `${race}×${n}`).join("、")}`,
    );

  const debuts = cards.filter((c) => c.firstPlay);
  if (debuts.length) {
    labels.push(`初登板: ${debuts.map((c) => c.nameJa).join("、")}`);
    highlight = true;
  }

  const repeat = cards.filter((c) => c.stock >= 3);
  if (repeat.length)
    labels.push(
      `何度も引いている札: ${repeat.map((c) => `${c.nameJa}（${c.stock}枚目の在庫）`).join("、")}`,
    );

  // いちばん重い1枚。「この1回のために何日おやすみさせるか」は肯定の材料として強い。
  const boldest = [...cards].sort(
    (a, b) => ZENKATSU_REST_DAYS[b.rarity] - ZENKATSU_REST_DAYS[a.rarity],
  )[0];
  if (boldest && ZENKATSU_REST_DAYS[boldest.rarity] >= ZENKATSU_REST_DAYS.SR) {
    labels.push(
      `今日いちばんの冒険: ${boldest.nameJa}（${boldest.rarity}・これで${ZENKATSU_REST_DAYS[boldest.rarity]}日おやすみになる）`,
    );
    if (HIGHLIGHT_RARITIES.has(boldest.rarity)) highlight = true;
  }

  if (combos.length) {
    // コンボは狙って組むもの。botたん には「気づいて触れてほしい」ので必ず渡す。
    labels.push(
      `コンボ成立: ${combos.map((c) => c.nameJa).join("、")}`,
    );
    highlight = true;
  }

  if (cards.length === 1) {
    // 1枚で答えるのは、3枚並べるのとは別の身振り。botたんに気づかせる。
    labels.push("1枚で答えた");
    highlight = true;
  }

  return { labels, highlight };
}

/**
 * 隠し採点。**プレイヤーには数値を見せない。**
 *
 * 見せるのは「追い風 x2」「コンボ成立」といった**出来事**だけで、合計点も順位も出さない。
 * 点数を見せた瞬間に上下が生まれ、下位を黙って否定することになる（docs/zenkatsu.md 1章）。
 * この数値の用途は、翌朝の「botたん賞」の候補を数件に絞ることだけ。
 *
 * **ATK/DEF を採点に入れていないのは意図的。** 高ATKのレアを出すのが得なゲームにすると、
 * 実測で60日かけて卓から消えていく N が完全に死ぬ（5章のレアリティ・インフレ）。
 * 追い風・コンボ・種族一致だけで採点すれば、**N がコンボ要員として一級品**になり、
 * 「N を厚く集めている人ほど組める」が成立する。
 */

/** 追い風1枚あたりの倍率。3枚すべて追い風なら 1.3^3 ≒ 2.2 倍。 */
const TAILWIND_MULTIPLIER = 1.3;
/** お題の種族と一致した1枚あたりの倍率。属性より控えめにする（持っていない人が出るため）。 */
const THEME_RACE_MULTIPLIER = 1.15;
/** 提出内で種族が揃った1組あたりの倍率。 */
const RACE_PAIR_MULTIPLIER = 1.1;
/** 初登板1枚あたりの倍率。使い回しより、新しい札を試すほうを少しだけ後押しする。 */
const DEBUT_MULTIPLIER = 1.05;

export interface ZenkatsuScoreInput {
  theme: { attribute: string; raceJa?: string };
  cards: readonly ZenkatsuReadingCard[];
  /** 成立したコンボの倍率（matchCombos の結果から取る）。 */
  comboBonuses: readonly number[];
}

export interface ZenkatsuScore {
  /** 隠し得点。**表示してはいけない。** botたん賞の候補を絞るためだけに使う。 */
  value: number;
  /** リザルトで見せる出来事。数値ではなく「何が起きたか」。 */
  tailwindCount: number;
  themeRaceCount: number;
  racePairCount: number;
  debutCount: number;
}

/**
 * 隠し得点を出す。倍率の積にしているのは、狙って重ねたときに素直に伸ばすため。
 * 1枚で出しても不利にならないよう、枚数そのものは点に入れない。
 */
export function scoreZenkatsu(input: ZenkatsuScoreInput): ZenkatsuScore {
  const tailwindCount = input.cards.filter(
    (c) => c.attribute === input.theme.attribute,
  ).length;
  const themeRaceCount = input.theme.raceJa
    ? input.cards.filter((c) => c.raceJa === input.theme.raceJa).length
    : 0;
  const raceCounts = new Map<string, number>();
  for (const card of input.cards)
    raceCounts.set(card.raceJa, (raceCounts.get(card.raceJa) ?? 0) + 1);
  const racePairCount = [...raceCounts.values()].filter((n) => n >= 2).length;
  const debutCount = input.cards.filter((c) => c.firstPlay).length;

  let value = 1;
  value *= TAILWIND_MULTIPLIER ** tailwindCount;
  value *= THEME_RACE_MULTIPLIER ** themeRaceCount;
  value *= RACE_PAIR_MULTIPLIER ** racePairCount;
  value *= DEBUT_MULTIPLIER ** debutCount;
  for (const bonus of input.comboBonuses) value *= bonus;

  return {
    // 小数のまま持つと比較のたびに誤差が乗るので、整数（1.00 = 100）に丸めて持つ。
    value: Math.round(value * 100),
    tailwindCount,
    themeRaceCount,
    racePairCount,
    debutCount,
  };
}
