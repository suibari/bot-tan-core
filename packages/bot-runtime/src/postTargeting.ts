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

export type NagiReplyJobRecord = PostRecordLike & { botSilent?: unknown };

export type NagiReplyJobDecision =
  | { enqueue: true; toBot: boolean }
  | {
      enqueue: false;
      reason: "own-post" | "bot-silent" | "not-addressed" | "third-party-thread";
    };

/**
 * Nagi の公開投稿に botたんの返信ジョブを積むかを決める。
 *
 * 積む側が nagi_bot_server（Jetstream）と nagi_appview（取り込み）の2か所にあるので、
 * 条件がずれると片方だけ返信する投稿ができてしまう。判定はここ1か所に置く。
 * こっそり投稿は URI から親の書き手を辿れないため対象外（AppView の作成経路が積む）。
 */
export function decideNagiReplyJob(
  record: NagiReplyJobRecord,
  authorDid: string,
  botDid: string,
): NagiReplyJobDecision {
  if (authorDid === botDid) return { enqueue: false, reason: "own-post" };
  // botたんサイレント機能がONの投稿には返信しない。
  if (record.botSilent) return { enqueue: false, reason: "bot-silent" };
  if (!record.reply) return { enqueue: true, toBot: false };

  const parentDid = didFromAtUri(record.reply.parent?.uri);
  const toBot = parentDid === botDid || mentionsDid(record, botDid);
  if (!toBot) return { enqueue: false, reason: "not-addressed" };
  // 他人のスレッド内で bot に話しかけられても割り込まない。bot の定期ポストへの返信は
  // 会話に乗せたいので、root が bot の場合は許可する。
  const kind = classifyPostThread(record, authorDid, botDid);
  if (kind === "third-party-thread" || kind === "bot-thread-third-party")
    return { enqueue: false, reason: "third-party-thread" };
  return { enqueue: true, toBot: true };
}
