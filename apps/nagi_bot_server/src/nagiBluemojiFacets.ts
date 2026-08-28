import {
  BLUEMOJI_NAME_RE,
  type EmojiView,
  type NagiPost,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  resolveBluemojiAliases,
  type EmojiAliasRequest,
} from "./appviewInternal.js";

type NagiFacet = NonNullable<NagiPost["facets"]>[number];
export type EmojiResolver = (
  aliases: EmojiAliasRequest[],
) => Promise<Array<{ name: string; emoji?: EmojiView }>>;

const INLINE_ALIAS_RE = /:[a-zA-Z0-9_-]{1,32}:/g;
const MAX_ALIASES = 100;

function preferredUris(sourceFacets: NagiPost["facets"] | undefined) {
  const found = new Map<string, string>();
  for (const facet of sourceFacets ?? []) {
    for (const feature of facet.features ?? []) {
      const item = feature as any;
      if (
        item?.$type !== "com.suibari.nagi.richtext#bluemoji" ||
        typeof item.name !== "string" ||
        typeof item.ref?.uri !== "string" ||
        !BLUEMOJI_NAME_RE.test(item.name)
      )
        continue;
      if (!found.has(item.name)) found.set(item.name, item.ref.uri);
    }
  }
  return found;
}

/** 本文に実在するエイリアスだけを重複なく集め、返信元の参照URIを優先候補にする。 */
export function collectBluemojiAliasRequests(
  text: string,
  sourceFacets?: NagiPost["facets"],
): EmojiAliasRequest[] {
  const preferred = preferredUris(sourceFacets);
  const names = new Set<string>();
  for (const match of text.matchAll(INLINE_ALIAS_RE)) {
    if (names.size >= MAX_ALIASES) break;
    if (BLUEMOJI_NAME_RE.test(match[0])) names.add(match[0]);
  }
  return [...names].map((name) => ({
    name,
    ...(preferred.has(name) ? { preferredUri: preferred.get(name)! } : {}),
  }));
}

/** 解決済みの絵文字から、本文中の全出現位置にユーザー投稿と同じ2種類のfacetを付ける。 */
export function buildBluemojiFacets(
  text: string,
  resolved: Array<{ name: string; emoji?: EmojiView }>,
  occupied: NagiFacet[] = [],
): NagiFacet[] {
  const emojis = new Map(
    resolved.flatMap((item) => (item.emoji ? [[item.name, item.emoji] as const] : [])),
  );
  const facets: NagiFacet[] = [];
  for (const match of text.matchAll(INLINE_ALIAS_RE)) {
    const emoji = emojis.get(match[0]);
    const index = match.index;
    if (!emoji || index === undefined) continue;
    const byteStart = Buffer.byteLength(text.slice(0, index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(match[0], "utf8");
    if (
      occupied.some(
        (facet) =>
          byteStart < facet.index.byteEnd && byteEnd > facet.index.byteStart,
      )
    )
      continue;
    facets.push({
      index: { byteStart, byteEnd },
      features: [
        ...(emoji.formats
          ? [
              {
                $type: "blue.moji.richtext.facet" as const,
                did: emoji.did,
                name: emoji.name,
                ...(emoji.alt ? { alt: emoji.alt } : {}),
                formats: emoji.formats,
              },
            ]
          : []),
        {
          $type: "com.suibari.nagi.richtext#bluemoji" as const,
          ref: { uri: emoji.uri, cid: emoji.cid },
          did: emoji.did,
          name: emoji.name,
          ...(emoji.alt ? { alt: emoji.alt } : {}),
          mediaType: emoji.mediaType,
        },
      ],
    } as NagiFacet);
  }
  return facets;
}

export async function resolveNagiBluemojiFacets(
  text: string,
  sourceFacets: NagiPost["facets"] | undefined,
  occupied: NagiFacet[] = [],
  resolver: EmojiResolver = resolveBluemojiAliases,
): Promise<NagiFacet[]> {
  const aliases = collectBluemojiAliasRequests(text, sourceFacets);
  if (!aliases.length) return [];
  try {
    return buildBluemojiFacets(text, await resolver(aliases), occupied);
  } catch (error) {
    // AppView の一時障害でbot投稿全体を止めず、ショートコードをフォールバック表示する。
    console.warn("[WARN][NAGI] Failed to resolve Bluemoji aliases:", error);
    return [];
  }
}
