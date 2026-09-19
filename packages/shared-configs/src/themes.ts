import {
  CARD_ATTRIBUTES,
  dayIndexOfDateKey,
  isCardRaceJa,
  type CardAttribute,
  type CardRaceJa,
} from "./cards.js";
import themesV1 from "./json/themes_v1.json" with { type: "json" };

/**
 * ゼンカツ！のお題（1日1つ、全ユーザー共通のシチュエーション）。
 *
 * カード定義と同じく静的な JSON（json/themes_v{n}.json）が真実源で、DB には持たない。
 * よって文言の修正は JSON を直すだけで全ユーザーに反映される。
 *
 * お題の同一性は **(volume, id) の組** で決まる。**一度リリースした (volume, id) は
 * 絶対に変更してはならない。** 提出レコードの索引から永続参照され、日付パーマリンクで
 * 過去のお題を引き直すのにも使うため。段の途中に差し込むこともできない（次の段に足す）。
 *
 * お題は LLM に生成させない。全ユーザー共通で公開される上、ネタお題は品質が命なので、
 * 量子化モデルに書かせると事故る。書き溜めた資産として積み上げる。
 */

/** お題のトーン。ネタ8割・素直2割で混ぜる（しんどい日の人を置き去りにしないため）。 */
export const THEME_TONES = ["neta", "sunao"] as const;
export type ThemeTone = (typeof THEME_TONES)[number];

export interface ThemeDefinition {
  /** 段内の通し番号（1始まり）。ファイル順と一致する。 */
  id: number;
  /** お題の段。初段=1。 */
  volume: number;
  textJa: string;
  textEn: string;
  /**
   * 追い風の属性。その日「噛み合う」札を決める主軸。
   *
   * 属性を主にするのは分布の都合。属性は6種で 4〜6枚ずつとほぼ均等だが、種族は20種あって
   * 1枚しかない種族が11個ある。種族を主にすると、その1枚を持っていない人の追い風が消える。
   */
  attribute: CardAttribute;
  /** 追い風の種族（任意）。持っていない人が出るので、あくまで副次的なボーナス。 */
  raceJa?: CardRaceJa;
  tone: ThemeTone;
}

/** 最新の段。二段目を出すときはここを上げ、themes_v2.json を足して THEME_DEFS に連結する。 */
export const THEME_VOLUME_LATEST = 1;

/** お題を一意に指す内部キー。 */
export function themeKey(theme: { volume: number; id: number }): string {
  return `${theme.volume}:${theme.id}`;
}

/** 表示・ログ用の番号。例: t1-001 */
export function themeCode(theme: { volume: number; id: number }): string {
  return `t${theme.volume}-${String(theme.id).padStart(3, "0")}`;
}

/**
 * 定義 JSON の健全性チェック。壊れた定義のまま配信すると、その日のお題が固定されて
 * 過去に残ってしまうので、起動時に落とす。
 */
function assertThemeDefs(defs: ThemeDefinition[]): ThemeDefinition[] {
  if (!defs.length) throw new Error("themes: no themes defined");
  const seen = new Set<string>();
  defs.forEach((theme, index) => {
    const key = themeKey(theme);
    if (seen.has(key))
      throw new Error(`themes: duplicated theme ${themeCode(theme)}`);
    seen.add(key);
    // 配列の並び＝id の昇順。ここがずれると番号と中身が食い違う。
    if (theme.id !== index + 1)
      throw new Error(
        `themes: id must be sequential from 1 in file order (expected ${index + 1}, got ${theme.id})`,
      );
    if (!CARD_ATTRIBUTES.includes(theme.attribute))
      throw new Error(
        `themes: unknown attribute "${theme.attribute}" (${themeCode(theme)})`,
      );
    // 種族は CARD_RACES が正典。表記ゆれがあると、どのカードにも一致せず
    // エラーも出ないまま追い風が黙って無効になるので、ここで落とす。
    if (theme.raceJa !== undefined && !isCardRaceJa(theme.raceJa))
      throw new Error(
        `themes: unknown race "${theme.raceJa}" (${themeCode(theme)})`,
      );
    if (!THEME_TONES.includes(theme.tone))
      throw new Error(`themes: unknown tone "${theme.tone}" (${themeCode(theme)})`);
    for (const field of ["textJa", "textEn"] as const) {
      if (!theme[field]?.trim())
        throw new Error(`themes: empty ${field} (${themeCode(theme)})`);
    }
  });
  return defs;
}

/** 全お題定義。 */
export const THEME_DEFS: readonly ThemeDefinition[] = assertThemeDefs(
  themesV1 as ThemeDefinition[],
);

const THEME_BY_KEY = new Map(THEME_DEFS.map((t) => [themeKey(t), t]));

export function getThemeDef(
  volume: number,
  id: number,
): ThemeDefinition | undefined {
  return THEME_BY_KEY.get(themeKey({ volume, id }));
}

/** 決定論的な擬似乱数（mulberry32）。巡回ごとの並べ替えにだけ使う。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 巡回番号 cycle における出題順（THEME_DEFS の添字の並べ替え）。
 *
 * 素朴に `日付 % お題数` にすると、お題数が7の倍数のとき（初段はちょうど42件）
 * **各お題が永久に同じ曜日に出続ける**。巡回ごとにシードを変えて並べ替えることで、
 * 「1巡でぜんぶ1回ずつ出る」を保ったまま曜日の固定を壊す。
 */
function orderForCycle(count: number, cycle: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const rand = mulberry32(cycle * 2654435761 + count);
  // Fisher-Yates。cycle と count が同じなら常に同じ並びになる。
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * その日付に割り当てるお題を決める。
 *
 * **この関数の結果を保存せずに使い回してはいけない。** お題を JSON に足すと
 * 割り当てが変わるので、過去の日付を後から解決し直すと違うお題が返る
 * （日付パーマリンクでさかのぼれる設計なので、それはアーカイブの破壊になる）。
 *
 * 正しい使い方は「その日を初めて開いたときに1度だけ呼び、結果を nagi.zenkatsu_daily へ
 * 焼き付ける」こと。以後は DB の値を読む。カード番号を変更禁止にしているのと同じ理屈。
 *
 * @param themeDate JST 4:00 始まりの "YYYY-MM-DD"（cardDrawDate と同じ日付キー）
 */
export function themeForDate(themeDate: string): ThemeDefinition {
  const count = THEME_DEFS.length;
  const day = dayIndexOfDateKey(themeDate);
  // 負の日付（1970年より前）でも剰余が負にならないようにする。
  const cycle = Math.floor(day / count);
  const pos = ((day % count) + count) % count;
  return THEME_DEFS[orderForCycle(count, cycle)[pos]];
}
