export interface WhimsicalPostTexts {
  bskyJa: string;
  bskyEn: string;
  nagiJa: string;
  nagiEn: string;
}

export interface GoodNightPostTexts {
  bsky: string;
  nagiJa: string;
  nagiEn: string;
  sourceUrl?: string;
}

function sections(...values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

export function getNagiThreadUrl(uri: string): string | undefined {
  const match =
    /^at:\/\/(did:(?:plc|web):[^/]+)\/com\.suibari\.nagi\.post\/([^/]+)$/.exec(
      uri,
    );
  if (!match) return undefined;
  return `https://nagi.suibari.com/thread/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
}

/** standard.site形式のブログは専用ページへ、通常投稿はスレッドへ。 */
export function getNagiPostUrl(uri: string): string | undefined {
  const article = /^at:\/\/(did:(?:plc|web):[^/]+)\/site\.standard\.document\/([^/]+)$/.exec(uri);
  if (article) {
    return `https://nagi.suibari.com/blog/${encodeURIComponent(article[1])}/${encodeURIComponent(article[2])}`;
  }
  return getNagiThreadUrl(uri);
}

export function getBlueskyPostUrl(uri: string): string | undefined {
  const match =
    /^at:\/\/(did:(?:plc|web):[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!match) return undefined;
  // Bluesky のルーターはDIDのコロンが %3A だと識別子として受け付けない。
  const actor = encodeURIComponent(match[1]).replace(/%3A/g, ":");
  return `https://bsky.app/profile/${actor}/post/${encodeURIComponent(match[2])}`;
}

/** 紹介元の公開URLを添える。Bluesky同士だけはリポストで紹介する。 */
export function buildGoodNightPostTexts(params: {
  textJa: string;
  textEn: string;
  sourcePost: { network: "bsky" | "nagi"; uri: string };
}): GoodNightPostTexts {
  const sourceUrl =
    params.sourcePost.network === "nagi"
      ? getNagiPostUrl(params.sourcePost.uri)
      : getBlueskyPostUrl(params.sourcePost.uri);
  return {
    bsky: sections(
      params.textJa,
      params.textEn,
      params.sourcePost.network === "nagi" ? sourceUrl : undefined,
    ),
    nagiJa: sections(params.textJa, sourceUrl),
    nagiEn: params.textEn,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/**
 * おやすみポストへ載せる「今日覚えた言葉」を絞る。
 *
 * 覚えた言葉は日本語の固有名詞がほとんどで、原語表記のまま textEn にも載る。
 * parseGoodNightResponse の textEn 判定（checkPredominantLanguage）は日本語文字が
 * max(12, ラテン文字数の10%) を超えると**投稿ごと捨てる**ので、候補を積みすぎると
 * 「その日のおやすみポストが出ない」に直結する。件数だけでなく日本語文字数の合計でも
 * 先に切っておく。
 *
 * 長すぎる1件で打ち切らず次を見るのは、40字まで許される label が1件混ざっただけで
 * 「今日は何も覚えなかった」にならないようにするため。
 */
export const GOOD_NIGHT_LEARNED_TERM_MAX_COUNT = 3;
export const GOOD_NIGHT_LEARNED_TERM_MAX_JA_CHARS = 20;

/** checkPredominantLanguage が数えるのと同じ文字種。 */
const countJapaneseChars = (text: string) =>
  (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;

export function selectGoodNightLearnedTerms<T extends { label: string }>(
  candidates: T[],
  maxCount = GOOD_NIGHT_LEARNED_TERM_MAX_COUNT,
  maxJapaneseChars = GOOD_NIGHT_LEARNED_TERM_MAX_JA_CHARS,
): T[] {
  const selected: T[] = [];
  let japanese = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxCount) break;
    const chars = countJapaneseChars(candidate.label);
    if (japanese + chars > maxJapaneseChars) continue;
    selected.push(candidate);
    japanese += chars;
  }
  return selected;
}

/**
 * Bluesky は external embed が1件なのでニュースURLを増やさない。
 * 複数リンクカードを持てるNagiだけ、検証済みの記事URLを本文へ加える。
 */
export function buildWhimsicalPostTexts(params: {
  textJa: string;
  textEn: string;
  moodSong?: string;
  selectedNewsUrl?: string;
}): WhimsicalPostTexts {
  return {
    bskyJa: sections(params.textJa, params.moodSong),
    bskyEn: sections(params.textEn, params.moodSong),
    nagiJa: sections(params.textJa, params.selectedNewsUrl, params.moodSong),
    nagiEn: sections(params.textEn, params.selectedNewsUrl, params.moodSong),
  };
}
