/**
 * 絵文字検索の語彙一致に使う正規化。クライアントの unicodeSearch.ts の
 * normalizeEmojiText と同じ規則にしておく（サーバー検索が落ちたときにクライアントが
 * 手元で同じ検索をするので、揺れると結果が変わって見える）。
 *
 * NFKC + 小文字化 + ひらがな→カタカナ（「ねこ」と「ネコ」を同一視する）。
 */
export function normalizeEmojiText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** SQL の translate() に渡すひらがな→カタカナの対応表（normalizeEmojiText の DB 側）。 */
export const HIRAGANA = Array.from({ length: 0x3096 - 0x3041 + 1 }, (_, i) =>
  String.fromCharCode(0x3041 + i),
).join("");
export const KATAKANA = Array.from({ length: HIRAGANA.length }, (_, i) =>
  String.fromCharCode(0x30a1 + i),
).join("");

/** LIKE のメタ文字をエスケープする。 */
export const escapeLike = (value: string) => value.replace(/[%_\\]/g, "\\$&");

/**
 * カスタム絵文字の search_text。1行目が画像の文字、2行目が絵柄の説明、
 * 3行目以降が連想語（語彙一致で「1行目と完全一致」を上位にするため行の役割を固定する）。
 */
export function formatEmojiSearchText(caption: {
  text: string;
  description: string;
  keywords: string[];
}): string {
  const line = (value: string) => value.replace(/\s+/g, " ").trim();
  return [
    line(caption.text),
    line(caption.description),
    ...caption.keywords.map(line).filter(Boolean),
  ].join("\n");
}

/** カスタム絵文字の埋め込み文。名前の区切りは空白にして語として読ませる。 */
export function customEmojiEmbedText(row: {
  name: string;
  alt: string | null;
  searchText: string | null;
}): string {
  const name = row.name.replace(/^:|:$/g, "").replace(/[_-]+/g, " ").trim();
  return [name, row.alt?.trim(), row.searchText?.trim()]
    .filter(Boolean)
    .join("\n");
}

const KANA_ROMAJI: Record<string, string> = {
  ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o",
  カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko",
  ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go",
  サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
  ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo",
  タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to",
  ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
  ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no",
  ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
  バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo",
  パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po",
  マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo",
  ヤ: "ya", ユ: "yu", ヨ: "yo",
  ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro",
  ワ: "wa", ヲ: "wo", ン: "n", ヴ: "vu",
};
const SMALL_Y: Record<string, string> = { ャ: "a", ュ: "u", ョ: "o" };
const SMALL_VOWEL: Record<string, string> = { ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o" };

/**
 * 正規化済み（カタカナ）の検索語をヘボン式ローマ字にする。かなを含まなければ undefined。
 *
 * カスタム絵文字の名前はローマ字（`:zannen:` `:kakunin_shimashita:`）なので、
 * 「ざんねん」と打った人に名前で当てるために使う。長音は直前の母音を重ねる
 * （本番の名前が `:okkee:` `:suruu_shimasu:` の書き方なので）。
 */
export function kanaToRomaji(value: string): string | undefined {
  if (!/[ァ-ヴー]/.test(value)) return undefined;
  const out: string[] = [];
  let geminate = false;
  const push = (syllable: string) => {
    if (geminate && syllable) {
      out.push(syllable.startsWith("ch") ? "t" : syllable[0]);
      geminate = false;
    }
    out.push(syllable);
  };
  for (const char of value) {
    const last = out[out.length - 1] ?? "";
    if (char === "ッ") geminate = true;
    else if (char === "ー") {
      const vowel = last.match(/[aeiou]$/)?.[0];
      if (vowel) out.push(vowel);
    } else if (SMALL_Y[char] && /i$/.test(last) && last.length > 1) {
      // キャ → kya、シャ → sha、ジャ → ja
      const base = last.slice(0, -1);
      out[out.length - 1] = /(sh|ch|j)$/.test(base)
        ? `${base}${SMALL_Y[char]}`
        : `${base}y${SMALL_Y[char]}`;
    } else if (SMALL_VOWEL[char] && last) {
      // ファ → fa、ティ → ti
      out[out.length - 1] = `${last.replace(/[aeiou]$/, "")}${SMALL_VOWEL[char]}`;
    } else push(KANA_ROMAJI[char] ?? SMALL_Y[char] ?? SMALL_VOWEL[char] ?? char);
  }
  return out.join("");
}
