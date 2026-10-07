/**
 * bot が投稿する本文の facet を、投稿してよい形に絞る（Bluesky / Nagi 共通）。
 *
 * `RichText.detectFacets` は本文の見た目からリンクとメンションを推測する。bot の本文は
 * 生成文や定型文に名前を差し込んだものなので、推測がそのまま事故になる。
 * 2026-09-26〜10-07 の Bluesky 投稿約4万件で実際に起きていたこと:
 *
 * - 呼びかけ名にハンドルを使った定型文（`syb07.bsky.socialさん、…`）や、ドメインを含む
 *   表示名（`Marko @ admin.education`）が、スキーム無しのドメインとしてリンクになった（約50件）。
 * - URL の直後に続く日本語までリンク先に含まれ、開けないリンクになった
 *   （`https://syb07.bsky.socialさん、そんな装備で…`、`last.fmと連携すれば…`）。
 * - 生成文が写した第三者の `@ハンドル` が解決され、無関係な人へ通知が飛んだ。
 *
 * そのため次の規則で絞る。
 * - リンク: 本文に `http(s)://` から書かれているものだけ残す。ASCII 以外の文字と
 *   末尾の句読点はリンクに含めない。
 * - メンション: `allowedMentionDids`（返信相手など）に含まれる DID だけ残す。
 * - タグやその他の feature はそのまま。
 */

/** atproto の facet 型（feature が $Typed の union）も Nagi の facet 型も受けられる形。 */
export interface BotPostFacetLike {
  index: { byteStart: number; byteEnd: number };
  features: readonly unknown[];
}

type FeatureFields = { $type?: unknown; uri?: unknown; did?: unknown };

const LINK = "app.bsky.richtext.facet#link";
const MENTION = "app.bsky.richtext.facet#mention";

/** facet の URL として残す部分。`extractUrls`（bot-brain の urlGuard）と同じ規則。 */
export function trimBotPostUrl(text: string): string | undefined {
  const match = text.match(/^https?:\/\/[\x21-\x7E]+/i);
  if (!match) return undefined;
  const url = match[0].replace(/[.,;:!?)\]}'"]+$/, "");
  return url.length > "https://".length ? url : undefined;
}

export function sanitizeBotPostFacets<F extends BotPostFacetLike>(
  text: string,
  facets: readonly F[] | undefined,
  options: { allowedMentionDids?: Iterable<string> } = {},
): F[] {
  if (!facets?.length) return [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);
  const allowedDids = new Set(options.allowedMentionDids ?? []);
  const result: F[] = [];

  for (const facet of facets) {
    const { byteStart, byteEnd } = facet.index;
    let index = facet.index;
    const features: unknown[] = [];

    for (const raw of facet.features) {
      const feature = (raw ?? {}) as FeatureFields;
      if (feature.$type === LINK) {
        const covered = decoder.decode(bytes.subarray(byteStart, byteEnd));
        const url = trimBotPostUrl(covered);
        if (!url) continue;
        if (url !== covered) {
          index = { byteStart, byteEnd: byteStart + encoder.encode(url).length };
          features.push({ ...feature, uri: url });
        } else {
          features.push(raw);
        }
      } else if (feature.$type === MENTION) {
        if (typeof feature.did === "string" && allowedDids.has(feature.did)) features.push(raw);
      } else {
        features.push(raw);
      }
    }

    if (features.length) result.push({ ...facet, index, features: features as F["features"] });
  }
  return result;
}
