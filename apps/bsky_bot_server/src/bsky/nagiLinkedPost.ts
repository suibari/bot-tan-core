import type { AppBskyRichtextFacet } from "@atproto/api";
import type { ScheduledPostNagiLink } from "@bsky-affirmative-bot/clients";

/** app.bsky.feed.post#text の上限。 */
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;
const ELLIPSIS = "…";
const NAGI_POST = /^at:\/\/(did:(?:plc|web):[^/]+)\/com\.suibari\.nagi\.post\/([^/]+)$/;
const URL_PATTERN = /https?:\/\/\S+/g;

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export interface NagiLinkedPost {
  text: string;
  /** コードで組み立てた Nagi へのリンク。post() の facet 検出では作れない（本文に URL が無い）。 */
  linkFacets: AppBskyRichtextFacet.Main[];
  /** 本文を冒頭で切ったときだけ入る、全文を持つ Nagi 投稿への強参照（com.suibari.nagi.longPost）。 */
  longPost?: { uri: string; cid: string };
}

export function nagiThreadUrl(uri: string): string | undefined {
  const match = NAGI_POST.exec(uri);
  if (!match) return undefined;
  return `https://nagi.suibari.com/thread/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
}

const graphemeCount = (text: string) => [...segmenter.segment(text)].length;
const byteLength = (text: string) => encoder.encode(text).length;
const fits = (text: string) => graphemeCount(text) <= MAX_GRAPHEMES && byteLength(text) <= MAX_BYTES;

function linkFacet(text: string, label: string, from: number, uri: string): AppBskyRichtextFacet.Main {
  const start = byteLength(text.slice(0, text.indexOf(label, from)));
  return {
    index: { byteStart: start, byteEnd: start + byteLength(label) },
    features: [{ $type: "app.bsky.richtext.facet#link", uri }],
  };
}

/**
 * 上限に収まる冒頭を切り出す。改行 > 空白 > grapheme 境界の順に区切り、URL の途中では切らない
 * （post() は本文の URL から facet を作り直すので、切れた URL は開けないリンクになる）。
 */
function cutOpening(text: string, reserved: string): string {
  const segments = [...segmenter.segment(text)].map(({ segment, index }) => ({ segment, index }));
  const urls = [...text.matchAll(URL_PATTERN)].map((match) => [match.index!, match.index! + match[0].length]);
  const insideUrl = (offset: number) => urls.some(([start, end]) => start < offset && offset < end);
  let limit = 0;
  while (limit < segments.length && fits(`${text.slice(0, segments[limit].index + segments[limit].segment.length)}${reserved}`))
    limit++;
  const offsetAt = (count: number) => (count < segments.length ? segments[count].index : text.length);
  const findBreak = (matches: (segment: string) => boolean) => {
    for (let count = limit; count > 0; count--) {
      if (insideUrl(offsetAt(count))) continue;
      if (matches(segments[count - 1].segment)) return count;
    }
    return -1;
  };
  const chosen = [
    findBreak((segment) => segment === "\n"),
    findBreak((segment) => /\s/.test(segment)),
    findBreak(() => true),
  ].find((count) => count > 0);
  return text.slice(0, offsetAt(chosen ?? limit)).trimEnd();
}

/**
 * 定期ポストの Bluesky 本文に、同じ内容の Nagi 投稿へのリンクを付ける。
 * 収まれば「本文 / 別言語への導線 / 末尾」、収まらなければ本文を冒頭で切って「…もっと見る」を付ける。
 * Nagi 投稿の URI が想定外の形なら undefined（呼び出し側はリンク無しで出す）。
 */
export function buildNagiLinkedPost(params: {
  text: string;
  footer?: string;
  nagiLink: ScheduledPostNagiLink;
  nagiPost: { uri: string; cid: string };
}): NagiLinkedPost | undefined {
  const url = nagiThreadUrl(params.nagiPost.uri);
  if (!url) return undefined;
  const { label, seeMoreLabel } = params.nagiLink;
  const body = params.text.trim();
  const footer = params.footer?.trim();
  const after = [label, footer].filter(Boolean).join("\n\n");

  const whole = [body, after].filter(Boolean).join("\n\n");
  if (fits(whole)) {
    return { text: whole, linkFacets: [linkFacet(whole, label, body.length, url)] };
  }

  const reserved = `${ELLIPSIS}${seeMoreLabel}\n\n${after}`;
  const opening = `${cutOpening(body, reserved)}${ELLIPSIS}`;
  const text = `${opening}${seeMoreLabel}\n\n${after}`;
  return {
    text,
    linkFacets: [
      linkFacet(text, seeMoreLabel, opening.length, url),
      linkFacet(text, label, opening.length + seeMoreLabel.length, url),
    ],
    longPost: { uri: params.nagiPost.uri, cid: params.nagiPost.cid },
  };
}
