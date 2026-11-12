/**
 * 日本語の露骨な性的語句の照合。
 *
 * OpenAI omni-moderation は日本語の俗語をほとんど知らない。2026-11 の実測で
 * 「パイズリ」単独の sexual は 0.099（英語の titjob でも 0.382）で、ラベル閾値の
 * 0.75 には遠く届かない。その穴をこのリストで埋める。
 *
 * 載せるのは性行為・性器を指す露骨な語だけ。「えっち」「エロ」「おっぱい」「性癖」
 * のような日常でも使う語は入れない（アニメ感想にラベルが付く）。
 * 「セックス」「射精」「潮吹き」「レイプ」なども、医療・ニュース・別の意味
 * （セックスレス、クジラの潮吹き）で普通に使われるので入れていない。
 *
 * 照合は単語の区切りで見る。Intl.Segmenter（ICU の辞書）で本文を語に区切り、語の
 * 始まりと終わりが区切りに重なるときだけ当たりにする（語が複数の区切りにまたがるのは
 * よい。「フェラ」は フェ|ラ に割れる）。2026-11-12 に「かわいいカフェラテ」が部分一致で
 * 当たったため、除外語を足していく方式からこちらへ切り替えた。ICU は知らないカタカナの
 * 連なりを1語にまとめるので、「カフェラテ」「ノスフェラトゥ」「パチンコ」は語の途中として
 * 自然に外れる。
 *
 * except は区切りでも外せない残り（ひらがなの「ぱちんこ」は ぱ|ち|ん|こ に割れうる）の
 * 保険として残している。except は「その語を含む、より長い語」を書く。
 * ICU の辞書は Node の更新で変わりうるので、区切りに頼る例はテストで押さえている。
 */

type ExplicitTerm = { term: string; except?: readonly string[] };

export const EXPLICIT_SEXUAL_TERMS: readonly ExplicitTerm[] = [
  { term: "パイズリ" },
  {
    term: "フェラ",
    // フェラーリ・フェラーラ・ルシフェラーゼ、ノスフェラトゥ、フェラガモ
    except: ["フェラー", "ノスフェラ", "フェラガモ"],
  },
  { term: "クンニ" },
  { term: "手コキ" },
  { term: "足コキ" },
  { term: "素股" },
  { term: "中出し" },
  { term: "顔射" },
  { term: "ハメ撮り" },
  { term: "生ハメ" },
  { term: "まんこ" },
  { term: "ちんぽ" },
  { term: "ちんこ", except: ["パチンコ"] },
  { term: "ザーメン" },
  { term: "オナニー" },
  { term: "輪姦" },
];

/** 区切りを取る前の正規化。カタカナは残す（カタカナのままのほうが ICU が語を見分ける）。 */
function foldWidthAndCase(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** カタカナをひらがなへ寄せる。1文字ずつの置き換えなので位置はずれない。 */
function katakanaToHiragana(value: string): string {
  return value.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * 照合用の正規化。NFKC で全角・半角をそろえ、小文字にし、カタカナをひらがなへ寄せる。
 * 「パイズリ」「ぱいずり」「ﾊﾟｲｽﾞﾘ」を同じ語として扱うため。
 */
export function normalizeForTerms(value: string): string {
  return katakanaToHiragana(foldWidthAndCase(value));
}

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

/** 語の区切りの位置（各語の先頭と末尾）。 */
function wordBoundaries(value: string): Set<number> {
  const boundaries = new Set<number>([value.length]);
  for (const { index } of segmenter.segment(value)) boundaries.add(index);
  return boundaries;
}

const COMPILED = EXPLICIT_SEXUAL_TERMS.map(({ term, except = [] }) => {
  const normalized = normalizeForTerms(term);
  return {
    term,
    normalized,
    except: except.map((value) => {
      const word = normalizeForTerms(value);
      return { word, offset: word.indexOf(normalized) };
    }),
  };
});

/** 本文に含まれる露骨な語を、リストの表記で返す。重複は除く。 */
export function findExplicitTerms(texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const folded = foldWidthAndCase(text);
    const normalized = katakanaToHiragana(folded);
    // 区切りは候補が見つかったときだけ取る。ほとんどの本文は1語も当たらない。
    let boundaries: Set<number> | undefined;
    for (const entry of COMPILED) {
      if (hits.includes(entry.term)) continue;
      let at = normalized.indexOf(entry.normalized);
      while (at >= 0) {
        boundaries ??= wordBoundaries(folded);
        const onBoundary =
          boundaries.has(at) && boundaries.has(at + entry.normalized.length);
        const excluded = !onBoundary || entry.except.some(
          // startsWith は負の位置を 0 に丸めるので、先頭より前にはみ出す候補は先に外す。
          ({ word, offset }) =>
            offset >= 0 && at - offset >= 0 && normalized.startsWith(word, at - offset),
        );
        if (!excluded) {
          hits.push(entry.term);
          break;
        }
        at = normalized.indexOf(entry.normalized, at + 1);
      }
    }
  }
  return hits;
}
