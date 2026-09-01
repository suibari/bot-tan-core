import { LinkMetadataError } from "./errors.js";
import { bytes, decode, decodeHtml, limitedFetch } from "./linkMetadata.js";

/**
 * リンク先の本文をプレーンテキストで取る。
 *
 * Gemini の URL Context（Google 側がページを取得していた）の置き換え。取得を自前で
 * 行うことになるため、**利用者が投稿した任意の URL を自宅サーバが叩く**構図になる。
 * SSRF 対策は linkMetadata.ts の `limitedFetch` に集約済み（`safeUrl` による
 * RFC1918 / ループバック / リンクローカル遮断、リダイレクト先の再検証、サイズ上限、
 * タイムアウト）。ここで独自に fetch を書かないこと。
 *
 * カード生成（`fetchLinkMetadata`）が OGP のメタタグだけを見るのに対し、こちらは
 * 本文そのものを返す。用途が違うので別関数にしている。
 */

/**
 * カード生成（1MB）より緩くしている。日本語の一覧ページは UTF-8 で 1 文字 3 バイトに
 * なるうえ広告タグが重く、実測で animatetimes の作品一覧が 1MB を超えて弾かれた。
 * 取得元は自分が選んだ検索結果で、ストリーム側でも上限を掛けており、テキスト化後に
 * さらに `limit` で切るのでメモリは膨らまない。
 */
const HTML_LIMIT = 3_000_000;
const DEFAULT_TEXT_LIMIT = 20_000;

/** script/style/noscript/svg/コメントは本文ではないので、タグごと中身を落とす。 */
const stripNonContent = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

/**
 * 本文らしい領域を優先する。ナビゲーションやフッターの定型文で上限を食い潰すと、
 * 肝心の固有名詞が切り落とされる。
 */
const mainRegion = (html: string) => {
  for (const pattern of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  ]) {
    const match = pattern.exec(html);
    if (match?.[1] && match[1].length > 200) return match[1];
  }
  return html;
};

/** ブロック要素は改行に、それ以外のタグは空白に落としてから実体参照を戻す。 */
const toPlainText = (html: string) =>
  decode(
    html
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );

export type ReadableText = { title: string; text: string };

export async function fetchReadableText(
  url: string,
  limit = DEFAULT_TEXT_LIMIT,
): Promise<ReadableText> {
  const { response, url: resolved } = await limitedFetch(
    url,
    "text/html,application/xhtml+xml",
  );
  if (!response.headers.get("content-type")?.toLowerCase().includes("html"))
    throw new LinkMetadataError(
      415,
      "unsupported_media_type",
      "Link is not an HTML page",
    );

  // Shift_JIS の日本語サイトがまだ現役なので、必ず宣言を見て復号する。
  // UTF-8 決め打ちにすると調査ブロックに文字化けが混入し、要約ごと汚染される。
  const html = decodeHtml(
    await bytes(response, HTML_LIMIT),
    response.headers.get("content-type"),
  );
  const title =
    decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") ||
    resolved.hostname;
  const text = toPlainText(mainRegion(stripNonContent(html)));

  if (!text)
    throw new LinkMetadataError(
      422,
      "metadata_unavailable",
      "Page body could not be extracted",
    );

  return { title: title.slice(0, 300), text: text.slice(0, limit) };
}
