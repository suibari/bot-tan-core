import type { BlueskyPushType } from "./pushPayload.js";

/**
 * Jetstream の1イベントから、Bluesky の通知の Push を送る相手を決める（クライアント仕様 NOTIFY-08）。
 * 外部への問い合わせをしない純粋な関数にして、受信のたびに安く判定できるようにする。
 * 宛先の判定は利用者が以前作った SkyPutter と同じ規則で、引用の recordWithMedia も拾う。
 */

export type JetstreamCommitEvent = {
  did: string;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: Record<string, unknown>;
  };
};

export type PostPreview = {
  text: string;
  hasImages: boolean;
  hasVideo: boolean;
  hasQuote: boolean;
};

export type BlueskyPushTarget = {
  recipientDid: string;
  type: BlueskyPushType;
  /** 通知のもとになったレコード（返信の投稿、いいね、フォローなど）。tag に使う。 */
  recordUri: string;
  /** いいね・リポストされた自分の投稿。本文はあとで公開 API から引く。 */
  subjectUri?: string;
  /** 返信・メンション・引用の本文。 */
  post?: PostPreview;
  /** 操作したレコードに付いたセルフラベル。年齢の保護に使う。 */
  selfLabels: string[];
};

const didOf = (uri: unknown): string | undefined => {
  if (typeof uri !== "string") return undefined;
  const match = /^at:\/\/(did:[^/]+)/.exec(uri);
  return match?.[1];
};

const typeOf = (value: unknown) => (value as { $type?: unknown } | undefined)?.$type;

function quotedUri(embed: unknown): string | undefined {
  switch (typeOf(embed)) {
    case "app.bsky.embed.record":
      return (embed as { record?: { uri?: string } }).record?.uri;
    case "app.bsky.embed.recordWithMedia":
      return (embed as { record?: { record?: { uri?: string } } }).record?.record?.uri;
    default:
      return undefined;
  }
}

function mediaOf(embed: unknown) {
  const media =
    typeOf(embed) === "app.bsky.embed.recordWithMedia"
      ? (embed as { media?: unknown }).media
      : embed;
  return {
    hasImages: typeOf(media) === "app.bsky.embed.images",
    hasVideo: typeOf(media) === "app.bsky.embed.video",
  };
}

function selfLabelsOf(record: Record<string, unknown>): string[] {
  const values = (record.labels as { values?: { val?: unknown }[] } | undefined)?.values;
  return (values ?? []).flatMap((value) => (typeof value.val === "string" ? [value.val] : []));
}

export function blueskyPushTargets(
  event: JetstreamCommitEvent,
  isRecipient: (did: string) => boolean,
): BlueskyPushTarget[] {
  const commit = event.commit;
  if (!commit || commit.operation !== "create" || !commit.record || !commit.rkey) return [];
  const { collection, record } = commit;
  const recordUri = `at://${event.did}/${collection}/${commit.rkey}`;
  const selfLabels = selfLabelsOf(record);
  const target = (recipientDid: string | undefined, type: BlueskyPushType, extra = {}) =>
    recipientDid && recipientDid !== event.did && isRecipient(recipientDid)
      ? [{ recipientDid, type, recordUri, selfLabels, ...extra }]
      : [];

  switch (collection) {
    case "app.bsky.feed.like":
    case "app.bsky.feed.repost": {
      const subjectUri = (record.subject as { uri?: unknown } | undefined)?.uri;
      return target(
        didOf(subjectUri),
        collection === "app.bsky.feed.like" ? "blueskyLike" : "blueskyRepost",
        { subjectUri },
      );
    }
    case "app.bsky.graph.follow":
      return target(
        typeof record.subject === "string" ? record.subject : undefined,
        "blueskyFollow",
      );
    case "app.bsky.feed.post": {
      const quote = quotedUri(record.embed);
      const post: PostPreview = {
        text: typeof record.text === "string" ? record.text : "",
        ...mediaOf(record.embed),
        hasQuote: Boolean(quote),
      };
      // 1つの投稿が返信・引用・メンションを兼ねても、同じ人へは1件だけ（返信 → 引用 → メンションの順）。
      const seen = new Set<string>();
      const results: BlueskyPushTarget[] = [];
      const add = (did: string | undefined, type: BlueskyPushType) => {
        if (!did || seen.has(did)) return;
        const found = target(did, type, { post });
        if (found.length) {
          seen.add(did);
          results.push(...found);
        }
      };
      const reply = record.reply as { parent?: { uri?: unknown } } | undefined;
      add(didOf(reply?.parent?.uri), "blueskyReply");
      add(didOf(quote), "blueskyQuote");
      const facets = (record.facets as { features?: { $type?: string; did?: unknown }[] }[]) ?? [];
      for (const facet of facets)
        for (const feature of facet.features ?? [])
          if (feature.$type === "app.bsky.richtext.facet#mention" && typeof feature.did === "string")
            add(feature.did, "blueskyMention");
      return results;
    }
    default:
      return [];
  }
}
