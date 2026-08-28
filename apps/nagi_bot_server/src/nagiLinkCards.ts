import { RichText } from "@atproto/api";
import { getLinkMetadata, getLinkThumbnail } from "@bsky-affirmative-bot/nagi-linkcard";
import type { NagiPost } from "@bsky-affirmative-bot/nagi-lexicon";
import { agent } from "./agent.js";
import {
  resolveNagiBluemojiFacets,
  type EmojiResolver,
} from "./nagiBluemojiFacets.js";

// Nagi の lexicon 上、linkCards は最大 4 件。
const MAX_LINK_CARDS = 4;

type NagiFacet = NonNullable<NagiPost["facets"]>[number];
type NagiLinkCardRecord = NonNullable<NagiPost["linkCards"]>[number];

/**
 * 本文から解決なしで安全に作れる facet を検出する。
 * mention は detectFacetsWithoutResolution だと did が handle のままの無効な facet になるため
 * 除外するが、link と tag はそのまま Nagi のレコードに保存できる。
 */
export function detectNagiFacets(text: string): { facets: NagiFacet[]; urls: string[] } {
  const rt = new RichText({ text });
  rt.detectFacetsWithoutResolution();

  const facets: NagiFacet[] = [];
  const urls: string[] = [];
  for (const facet of rt.facets ?? []) {
    const features = facet.features.filter(
      (feature: any) =>
        (feature?.$type === "app.bsky.richtext.facet#link" &&
          typeof feature.uri === "string") ||
        (feature?.$type === "app.bsky.richtext.facet#tag" &&
          typeof feature.tag === "string"),
    );
    if (!features.length) continue;
    facets.push({ index: facet.index, features });
    for (const feature of features as Array<{ $type: string; uri?: string }>) {
      if (
        feature.$type === "app.bsky.richtext.facet#link" &&
        feature.uri &&
        !urls.includes(feature.uri)
      ) {
        urls.push(feature.uri);
      }
    }
  }
  return { facets, urls };
}

/** リンク・タグに重ならない位置へBluemoji facetを加える、bot投稿共通のfacet生成。 */
export async function buildNagiPostFacets(
  text: string,
  sourceFacets?: NagiPost["facets"],
  resolver?: EmojiResolver,
): Promise<{ facets: NagiFacet[]; urls: string[] }> {
  const detected = detectNagiFacets(text);
  const emojis = await resolveNagiBluemojiFacets(
    text,
    sourceFacets,
    detected.facets,
    resolver,
  );
  return {
    facets: [...detected.facets, ...emojis].sort(
      (a, b) => a.index.byteStart - b.index.byteStart,
    ),
    urls: detected.urls,
  };
}

/**
 * URL ごとに OGP を取得してリンクカードを組み立てる。
 * appview (Nagi クライアントの投稿経路) と同じ getLinkMetadata を使うため、
 * クライアントから投稿したときと同じカードになる。
 */
export async function buildLinkCards(urls: string[]): Promise<NagiLinkCardRecord[]> {
  const cards: NagiLinkCardRecord[] = [];

  for (const url of urls.slice(0, MAX_LINK_CARDS)) {
    try {
      const metadata = await getLinkMetadata(url);
      // 取得に失敗すると { uri, title: hostname } が返る。中身の無いカードは
      // Bluesky 側（OGP が取れなければカードを付けない）に合わせてスキップする。
      const isEmpty =
        !metadata.image && !metadata.description && metadata.title === new URL(url).hostname;
      if (isEmpty) continue;

      let thumb: NagiLinkCardRecord["thumb"];
      if (metadata.image) {
        try {
          // サイズ (1MB) と mime 種別の検証は getLinkThumbnail 側で担保されており、
          // Nagi の validateRecord が要求する制約と一致する。
          const { data, contentType } = await getLinkThumbnail(metadata.image);
          const { blob } = (await agent.uploadBlob(data, { encoding: contentType })).data;
          // uploadBlob が返すのは BlobRef クラス (ref は CID、$type は toJSON でしか付かない)
          // なので、レコードに載せる JSON 形へ明示的に変換する。
          thumb = {
            $type: "blob",
            ref: { $link: blob.ref.toString() },
            mimeType: blob.mimeType,
            size: blob.size,
          };
        } catch (error) {
          console.warn(`[WARN][NAGI] Failed to upload link thumbnail for ${url}:`, error);
        }
      }

      cards.push({
        uri: metadata.uri,
        title: metadata.title,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(thumb ? { thumb } : {}),
      });
    } catch (error) {
      // 1 件の失敗で投稿全体を落とさない。
      console.warn(`[WARN][NAGI] Failed to build link card for ${url}:`, error);
    }
  }

  return cards;
}

/**
 * 本文に対応する facets / linkCards を返す。リンクカード生成が失敗しても
 * 投稿自体は成功させたいので、例外は握りつぶして空の結果を返す。
 */
export async function buildNagiPostAttachments(
  text: string,
  sourceFacets?: NagiPost["facets"],
  resolver?: EmojiResolver,
): Promise<{ facets?: NagiFacet[]; linkCards?: NagiLinkCardRecord[] }> {
  try {
    const { facets, urls } = await buildNagiPostFacets(text, sourceFacets, resolver);
    if (!facets.length) return {};
    const linkCards = await buildLinkCards(urls);
    return {
      facets,
      ...(linkCards.length ? { linkCards } : {}),
    };
  } catch (error) {
    console.warn("[WARN][NAGI] Failed to build link attachments:", error);
    return {};
  }
}
