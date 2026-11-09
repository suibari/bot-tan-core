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
 * 日本語には単語の区切りが無いので部分一致で見る。その代わり、長い語の一部として
 * 現れる誤検知を except で外す。except は「その語を含む、より長い語」を書く。
 * 2026-11-10 に本番の投稿・プロフィール・チャンネル（ユーザー分 4,174 件）へ当てた
 * ときの誤検知は「パチンコ」と「ノスフェラトゥ」の2つだった。
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

/**
 * 照合用の正規化。NFKC で全角・半角をそろえ、小文字にし、カタカナをひらがなへ寄せる。
 * 「パイズリ」「ぱいずり」「ﾊﾟｲｽﾞﾘ」を同じ語として扱うため。
 */
export function normalizeForTerms(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
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
    const normalized = normalizeForTerms(text);
    for (const entry of COMPILED) {
      if (hits.includes(entry.term)) continue;
      let at = normalized.indexOf(entry.normalized);
      while (at >= 0) {
        const excluded = entry.except.some(
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
