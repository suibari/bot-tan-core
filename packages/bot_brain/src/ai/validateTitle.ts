/**
 * 日記・占いの称号に載せてはいけない語の検出。
 *
 * 称号はラベラー定義として公開され、Nagi のバッジにも次の更新まで残る。
 * プロンプトで禁じても 26B / Gemini はときどき踏むので、生成後にもここで止める。
 * 本番の既存称号 606 件を見直して実際に出ていたもの:
 *   「街を駆け抜ける多動の旅人」「真のスクムの伝説 / The True Scum Legend」
 *   「プールと骨折の日記」「台風と75歳の浮腫みパラドックス」「笑涙で送るヤニとのお別れ」
 *   「肯定的なゲーマーの女神」「鋭い審美眼の 애니메이션愛好家」
 *
 * 一般語に含まれる部分文字列（カスタム・バカンス・サイコー・デブリ・姫路・熱狂 など）は
 * 誤検知になるので、語を絞るか否定先読みで外している。人名は機械的に判定できないため
 * プロンプト側だけで扱う。
 */

const TITLE_RULES: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  {
    category: "disorder",
    pattern:
      /多動|ADHD|ＡＤＨＤ|発達障|アスペ(?!ク)|自閉|メンヘラ|病み|コミュ障|躁|鬱|うつ病|依存症|中毒|サイコパス|狂人|発狂/i,
  },
  {
    category: "slur",
    pattern: /クズ|ゴミ|バカ(?!ンス)|アホ|ガイジ|池沼|キチガイ|基地外|デブ(?!リ)|ブス|スクム/,
  },
  {
    category: "health",
    pattern:
      /骨折|怪我|ケガ|浮腫|むくみ|二日酔い|夏バテ|持病|通院|入院|手術|発熱|風邪|頭痛|腹痛|病気|[0-9０-９]+\s*歳/,
  },
  { category: "smoking", pattern: /タバコ|たばこ|煙草|ヤニ|喫煙|禁煙/ },
  {
    category: "gender",
    pattern: /女神|姫(?!路)|プリンセス|女王|女優|魔女|令嬢|お嬢|淑女|パティシエール/,
  },
  {
    category: "english",
    pattern:
      /\b(?:hyperactiv\w*|adhd|ocd|autis\w*|asperger\w*|psycho\w*|manic|maniac|insane|lunatic|crazy|addict\w*|junkie|schizo\w*|bipolar|depress\w*|retard\w*|scum|trash|idiot|stupid|moron|loser|freak|injur\w*|fractur\w*|hangover|fatigue|sick|smok\w*|cigarette\w*|\d+[- ]years?[- ]old|goddess|princess|queen|actress|witch|lady|madam|heiress)\b/i,
  },
];

/** title_ja に混ざってはいけない文字（ハングル・キリル・アラビア・タイ）。 */
const FOREIGN_SCRIPT_JA = /[ᄀ-ᇿ㄰-㆏가-힯Ѐ-ӿ؀-ۿ฀-๿]/;

/** 違反があればそのカテゴリ名を返す。問題なければ null。 */
export function findTitleViolation(titleJa: string, titleEn: string): string | null {
  for (const { category, pattern } of TITLE_RULES) {
    if (pattern.test(titleJa) || pattern.test(titleEn)) return category;
  }
  if (FOREIGN_SCRIPT_JA.test(titleJa)) return "foreign_script";
  return null;
}

export function assertTitleIsSafe(titleJa: string, titleEn: string): void {
  const violation = findTitleViolation(titleJa, titleEn);
  if (violation) {
    throw new Error(`Title contains a disallowed term (${violation}): ${titleJa} / ${titleEn}`);
  }
}
