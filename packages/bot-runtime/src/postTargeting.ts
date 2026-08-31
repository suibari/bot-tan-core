export type PostRecordLike = {
  facets?: Array<{
    features?: Array<{ $type?: string; did?: string } | null> | null;
  } | null> | null;
  reply?: {
    root?: { uri?: string } | null;
    parent?: { uri?: string } | null;
  } | null;
};

export type PostThreadKind =
  | "top-level"
  | "self-thread"
  | "bot-thread"
  | "bot-thread-third-party"
  | "third-party-thread";

/** AT URI の authority DID を返す。不正な値は安全側で undefined にする。 */
export function didFromAtUri(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith("at://")) return undefined;
  const did = uri.slice("at://".length).split("/")[0];
  return did || undefined;
}

/** 本文中の全 Mention Facet を走査して、出現順にDIDを返す。 */
export function mentionedDids(record: PostRecordLike): string[] {
  if (!Array.isArray(record?.facets)) return [];
  const dids: string[] = [];
  for (const facet of record.facets) {
    if (!Array.isArray(facet?.features)) continue;
    for (const feature of facet.features) {
      if (
        feature?.$type === "app.bsky.richtext.facet#mention" &&
        typeof feature.did === "string"
      ) {
        dids.push(feature.did);
      }
    }
  }
  return dids;
}

export function mentionsDid(record: PostRecordLike, did: string): boolean {
  return mentionedDids(record).includes(did);
}

/**
 * 投稿者・bot・第三者のどれがスレッドを所有し、誰への返信かを分類する。
 * root が欠けたレコードは parent を代用し、判定不能なら第三者扱いに倒す。
 */
export function classifyPostThread(
  record: PostRecordLike,
  authorDid: string,
  botDid: string,
): PostThreadKind {
  if (!record.reply) return "top-level";

  const parentDid = didFromAtUri(record.reply.parent?.uri);
  const rootDid = didFromAtUri(record.reply.root?.uri) ?? parentDid;
  if (rootDid === authorDid) return "self-thread";
  if (rootDid === botDid) {
    return parentDid === botDid || parentDid === authorDid
      ? "bot-thread"
      : "bot-thread-third-party";
  }
  return "third-party-thread";
}
