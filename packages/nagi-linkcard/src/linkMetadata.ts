import { LinkMetadataError } from "./errors.js";
import { safeUrl } from "./ssrf.js";

const HTML_LIMIT = 1_000_000;
const IMAGE_LIMIT = 1_000_000;
const CARDYB_LIMIT = 100_000;
const REDIRECT_LIMIT = 4;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/** readable.ts と共用。SSRF 検証・リダイレクト上限・タイムアウトをまとめて掛ける。 */
export async function limitedFetch(raw: string, accept: string) {
  let url = await safeUrl(raw);
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { accept, "user-agent": "NagiLinkPreview/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === REDIRECT_LIMIT)
        throw new LinkMetadataError(502, "upstream_unavailable", "Too many redirects");
      url = await safeUrl(location, url);
      continue;
    }
    if (!response.ok)
      throw new LinkMetadataError(502, "upstream_unavailable", "Link could not be fetched");
    return { response, url };
  }
  throw new LinkMetadataError(502, "upstream_unavailable", "Link could not be fetched");
}

/** readable.ts と共用。content-length とストリームの両方でサイズ上限を掛ける。 */
export async function bytes(response: Response, limit: number) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit)
    throw new LinkMetadataError(413, "response_too_large", "Remote content is too large");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new LinkMetadataError(413, "response_too_large", "Remote content is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * readable.ts と共用。HTML のバイト列を正しい文字コードで文字列にする。
 *
 * 既定の `new TextDecoder()` は UTF-8 固定なので、Shift_JIS のサイトが文字化けする。
 * 実測: オリコンの記事が「�y�ăh���}2026 �܂Ƃ߁z」になった。日本語サイトには
 * まだ Shift_JIS / EUC-JP が残っているので、宣言を見て切り替える。
 *
 * 優先順位は HTML 仕様どおり Content-Type ヘッダ → meta 宣言 → UTF-8。
 * meta を読むために先頭を latin1 で覗くが、どの日本語エンコーディングでも
 * ASCII 範囲のバイト列は同じなので charset 宣言自体はこれで拾える。
 */
export function decodeHtml(buffer: Uint8Array, contentType?: string | null): string {
  const head = new TextDecoder("latin1").decode(buffer.subarray(0, 2048));
  const candidates = [
    /charset=["']?\s*([\w:.-]+)/i.exec(contentType ?? "")?.[1],
    /<meta[^>]+charset=["']?\s*([\w:.-]+)/i.exec(head)?.[1],
    /<meta[^>]+content=["'][^"']*charset=\s*([\w:.-]+)/i.exec(head)?.[1],
  ];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(buffer);
    } catch {
      // 未知のラベルは無視して次の候補へ。文字コードの判定失敗で取得ごと落とさない。
    }
  }
  return new TextDecoder().decode(buffer);
}

/** readable.ts と共用。HTML実体参照を戻し、空白を1つに畳む。 */
export const decode = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
const meta = (html: string, keys: string[]) => {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const pattern of [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
    ]) {
      const match = pattern.exec(html);
      if (match) return decode(match[1]);
    }
  }
};
const crop = (value: string | undefined, length: number) => value?.slice(0, length) || undefined;

export type LinkMetadata = {
  uri: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
  publishedAt?: string;
};

const linkHref = (html: string, rel: string): string | undefined => {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pattern of [
    new RegExp(`<link[^>]+rel=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>`, "i"),
  ]) {
    const match = pattern.exec(html);
    if (match) return decode(match[1]);
  }
};

const validPublishedAt = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

async function fetchDirect(url: URL, requireTitle = false): Promise<LinkMetadata> {
  const { response, url: resolved } = await limitedFetch(url.href, "text/html,application/xhtml+xml");
  if (!response.headers.get("content-type")?.toLowerCase().includes("html"))
    throw new LinkMetadataError(415, "unsupported_media_type", "Link is not an HTML page");
  const html = decodeHtml(await bytes(response, HTML_LIMIT), response.headers.get("content-type"));
  const extractedTitle =
    meta(html, ["og:title", "twitter:title"]) ??
    decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  if (requireTitle && !extractedTitle)
    throw new LinkMetadataError(422, "metadata_unavailable", "Article title could not be extracted");
  const description = meta(html, ["og:description", "twitter:description", "description"]);
  const image = meta(html, ["og:image:secure_url", "og:image", "twitter:image"]);
  const siteName = meta(html, ["og:site_name", "application-name"]);
  const publishedAt = validPublishedAt(meta(html, ["article:published_time", "datePublished"]));
  const canonical = linkHref(html, "canonical");
  const canonicalUrl = canonical ? await safeUrl(canonical, resolved) : resolved;
  return {
    uri: canonicalUrl.href,
    title: crop(extractedTitle, 300) || resolved.hostname,
    ...(crop(description, 1000) ? { description: crop(description, 1000) } : {}),
    ...(image ? { image: (await safeUrl(image, resolved)).href } : {}),
    ...(crop(siteName, 200) ? { siteName: crop(siteName, 200) } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

async function fetchViaCardyb(url: URL): Promise<LinkMetadata | undefined> {
  try {
    const response = await fetch(
      `https://cardyb.bsky.app/v1/extract?url=${encodeURIComponent(url.href)}`,
      {
        headers: { accept: "application/json", "user-agent": "NagiLinkPreview/1.0" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return;
    const body = JSON.parse(new TextDecoder().decode(await bytes(response, CARDYB_LIMIT))) as {
      url?: string;
      title?: string;
      description?: string;
      image?: string;
      error?: string;
    };
    if (body.error || !body.title?.trim()) return;
    const resolved = body.url ? await safeUrl(body.url) : url;
    const image = body.image ? await safeUrl(body.image, resolved) : undefined;
    return {
      uri: resolved.href,
      title: crop(body.title.trim(), 300)!,
      ...(crop(body.description?.trim(), 1000)
        ? { description: crop(body.description?.trim(), 1000) }
        : {}),
      ...(image ? { image: image.href } : {}),
    };
  } catch {
    return;
  }
}

export async function getLinkMetadata(raw: string, forceFallback = false) {
  const url = await safeUrl(raw);
  if (forceFallback)
    return (await fetchViaCardyb(url)) ?? { uri: url.href, title: url.hostname };
  try {
    const direct = await fetchDirect(url);
    if (direct.image) return direct;
    const fallback = await fetchViaCardyb(url);
    return fallback?.image ? { ...direct, image: fallback.image } : direct;
  } catch {
    return (await fetchViaCardyb(url)) ?? { uri: url.href, title: url.hostname };
  }
}

/**
 * ニュース投稿用の厳格なメタデータ取得。通常のリンクカードと違い、ホスト名だけの
 * フォールバックは成功扱いにしない。ユーザーへ個別項目を入力させず、安全に取得できた
 * 記事だけを審査へ送るための境界。
 */
export async function getNewsMetadata(raw: string): Promise<LinkMetadata> {
  const url = await safeUrl(raw);
  try {
    const direct = await fetchDirect(url, true);
    return { ...direct, siteName: direct.siteName ?? new URL(direct.uri).hostname };
  } catch (directError) {
    if (
      directError instanceof LinkMetadataError &&
      ![422, 502].includes(directError.status)
    )
      throw directError;
    const fallback = await fetchViaCardyb(url);
    if (fallback?.title?.trim())
      return { ...fallback, siteName: new URL(fallback.uri).hostname };
    if (directError instanceof LinkMetadataError) throw directError;
    throw new LinkMetadataError(422, "metadata_unavailable", "Article metadata could not be extracted");
  }
}

// <link rel="...icon..."> の href を rel ごとに拾う。icon / shortcut icon / apple-touch-icon を対象。
const iconLink = (html: string): string | undefined => {
  const re = /<link\b[^>]*>/gi;
  let best: { href: string; score: number } | undefined;
  for (const tag of html.match(re) ?? []) {
    const rel = /\brel=["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b/.test(rel)) continue;
    const href = /\bhref=["']([^"']*)["']/i.exec(tag)?.[1];
    if (!href) continue;
    // apple-touch-icon > icon > shortcut icon をやや優先（大きめ・確実なもの）。
    const score = rel.includes("apple-touch-icon") ? 3 : rel === "icon" ? 2 : 1;
    if (!best || score > best.score) best = { href: decode(href), score };
  }
  return best?.href;
};

/**
 * アプリの Web サイト URL から favicon の絶対URLを解決する。ページHTMLの
 * <link rel=icon> 等を優先し、無ければ origin 直下の /favicon.ico にフォールバック。
 * 画像そのものは取得せず URL だけ返す（表示側が <img> で読む）。
 */
export async function resolveFavicon(raw: string): Promise<{ iconUrl?: string }> {
  const url = await safeUrl(raw);
  const fallback = new URL("/favicon.ico", url).href;
  try {
    const { response, url: resolved } = await limitedFetch(
      url.href,
      "text/html,application/xhtml+xml",
    );
    if (!response.headers.get("content-type")?.toLowerCase().includes("html"))
      return { iconUrl: fallback };
    const html = decodeHtml(await bytes(response, HTML_LIMIT), response.headers.get("content-type"));
    const href = iconLink(html);
    if (!href) return { iconUrl: fallback };
    // href は相対・プロトコル相対・data: いずれもありうる。safeUrl で絶対化＋SSRF/スキーム検証。
    if (href.startsWith("data:")) return { iconUrl: href };
    return { iconUrl: (await safeUrl(href, resolved)).href };
  } catch {
    return { iconUrl: fallback };
  }
}

export async function getLinkThumbnail(raw: string) {
  const { response } = await limitedFetch(raw, "image/jpeg,image/png,image/webp");
  const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? "";
  if (!allowedImageTypes.has(contentType))
    throw new LinkMetadataError(415, "unsupported_media_type", "Unsupported link thumbnail type");
  return { data: await bytes(response, IMAGE_LIMIT), contentType };
}
