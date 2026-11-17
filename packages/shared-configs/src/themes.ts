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

/** 決定論的な擬似乱数（mulberry32）。同じ日付なら同じ選択になるようにだけ使う。 */
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

/** これまでに焼き付けたお題の履歴（nagi.zenkatsu_daily の行）。 */
export interface ThemeHistoryEntry {
  themeDate: string;
  volume: number;
  id: number;
}

/**
 * 出たことのあるお題から選ぶとき、古い順に並べた先頭のこの割合を候補にする。
 *
 * 「いちばん古い1件」に絞らないのは、それだと2巡目以降が1巡目と同じ順番の繰り返しになり、
 * お題数が7の倍数なら各お題が永久に同じ曜日に出続けるため。先頭4分の1から選べば、
 * 再登場までの間隔はおおむね「お題数の4分の3」以上を保ったまま、順番は毎巡崩れる。
 */
const RECENT_POOL_RATIO = 0.25;

/**
 * その日付に割り当てるお題を、これまでの履歴から決める。
 *
 * 1. **まだ一度も出ていないお題を優先する。** JSON にお題を足すと、それが先に出る
 * 2. 全部出ていたら、最後に出た日が古いものから選ぶ（直前に出たお題はすぐには戻らない）
 *
 * 以前は「日付から巡回を計算する」方式だったが、お題を足すと件数が変わって巡回が
 * 途中で組み直され、最近出たお題がすぐまた出たり、足したお題がいつまでも出なかったりした。
 *
 * **結果は保存して使うこと。** 履歴が変われば結果も変わるので、その日を初めて開いたときに
 * 1度だけ呼び、nagi.zenkatsu_daily へ焼き付ける。以後は DB の値を読む。
 *
 * @param themeDate JST 4:00 始まりの "YYYY-MM-DD"（cardDrawDate と同じ日付キー）
 * @param history 焼き付け済みのお題。themeDate 以降の行は無視する
 */
export function pickThemeForDate(
  themeDate: string,
  history: readonly ThemeHistoryEntry[],
  defs: readonly ThemeDefinition[] = THEME_DEFS,
): ThemeDefinition {
  const day = dayIndexOfDateKey(themeDate);
  const lastUsed = new Map<string, string>();
  for (const entry of history) {
    if (entry.themeDate >= themeDate) continue;
    const key = themeKey(entry);
    const prev = lastUsed.get(key);
    if (prev === undefined || entry.themeDate > prev)
      lastUsed.set(key, entry.themeDate);
  }

  const unused = defs.filter((theme) => !lastUsed.has(themeKey(theme)));
  let pool: readonly ThemeDefinition[];
  if (unused.length) {
    pool = unused;
  } else {
    // 古い順。同じ日付は定義順で並べて、結果を決定論にする。
    const byAge = [...defs].sort((a, b) => {
      const da = lastUsed.get(themeKey(a))!;
      const db = lastUsed.get(themeKey(b))!;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    pool = byAge.slice(0, Math.max(1, Math.floor(defs.length * RECENT_POOL_RATIO)));
  }
  const rand = mulberry32(day * 2654435761 + defs.length);
  return pool[Math.floor(rand() * pool.length)];
}
