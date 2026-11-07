import type { BotMemoryImpressionInput } from "@bsky-affirmative-bot/database";

/**
 * 印象ラベルのうち、調査キューへ積むものを選ぶ。
 *
 * 【なぜ絞るか】
 * 調査キューの入口は実質ここだけで、2026-11-07 時点の本番では
 *   - 言葉（word）: 1190件 → 成功 165（14%）、検索 3287回（全体の83%）
 *   - 作品（work）:  292件 → 成功 119（41%）、検索  653回
 * だった。言葉ラベルの大半は「雨だったがお出かけなどがんばった」「today is my birthday」
 * のような文で、検索しても何も出ないか、出ても「good」「Yes!!」のような役に立たない
 * カードになる。しかもカードは投稿に語が文字どおり出れば返信の材料に入るので、
 * 「good」のカードは英語の投稿に片っ端から混ざる。
 *
 * そして検索は自前の SearXNG 経由のスクレイピングで、量が多いと上流（Yahoo）に
 * ボットとして目を付けられる。実際に自宅の IPv4 は汚染された結果を返されるようになった。
 * 当たらない検索を減らすことは、そのまま検索基盤の延命になる。
 *
 * 作品名は弾かない。「転生したら剣でした」「追放されたチート付与魔術師は気ままな
 * セカンドライフを謳歌する」のように、文の形をした長い題名が普通にあるため。
 */
export function researchLabelsFrom(
  impressions: Pick<BotMemoryImpressionInput, "kind" | "label">[],
): string[] {
  return impressions
    .filter((item) => item.kind === "work" || isResearchableWord(item.label))
    .map((item) => item.label);
}

/** 文の形を示す語尾・助詞の連なり。語（名詞）にはまず出てこない。 */
const SENTENCE_PATTERN =
  /(?:って|ので|から|けど|ます|でした|しかない|ている|てる|ない$|した$|する$|れる$|たい$|[^ー]た$|のやつ|だった|ような|ように|みたい|ください|たく|[をにがはへでと][^\x00-\x7F]{1,3}(?:る|た|い|う)$)/;

/** 句読点・感嘆符・括弧・顔文字に使われる記号。語には含まれない。 */
const PUNCTUATION_PATTERN = /[。、！？!?＼／()（）「」『』…~〜]/;

/** 英語の相づち・感想。大文字で書かれていても固有名詞ではない。 */
const ENGLISH_FILLER_PATTERN =
  /^(?:yes|no|true|false|ok|okay|thanks?|thank you|good|nice|wow|lol|omg|fuck.*)$/i;

/**
 * 言葉ラベルのうち、調べる価値がある（固有名詞らしい短い語）か。
 *
 * 本番のラベル 1190件で、検索回数は 3287 → 1302 回に減り、成功していたもののうち
 * 弾かれるのは「good」「birthday」「jerk off to porn」のような役に立たないカードが大半だった。
 * 取りこぼすのは「korean war」「biden」のような小文字書きの固有名詞くらい。
 */
export function isResearchableWord(label: string): boolean {
  const text = label.normalize("NFKC").trim();
  const length = [...text].length;
  if (length < 2 || length > 20) return false;
  if (PUNCTUATION_PATTERN.test(text)) return false;
  if (SENTENCE_PATTERN.test(text)) return false;
  if (/^[\x00-\x7F]+$/.test(text)) {
    if (text.split(/\s+/).length > 3) return false;
    // 英語は固有名詞らしいもの（大文字か数字を含む）だけ。一般語は調べても役に立たない。
    if (!/[A-Z0-9]/.test(text)) return false;
    if (ENGLISH_FILLER_PATTERN.test(text.replace(/[^A-Za-z ]/g, "").trim())) return false;
  }
  return true;
}
