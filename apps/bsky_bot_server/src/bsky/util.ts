import { $Typed, AppBskyEmbedDefs, AppBskyEmbedExternal, AppBskyEmbedImages, AppBskyEmbedNS, AppBskyEmbedRecord, AppBskyEmbedRecordWithMedia, AppBskyEmbedVideo } from "@atproto/api";
import { AppBskyFeedDefs } from "@atproto/api"; type PostView = AppBskyFeedDefs.PostView; type FeedViewPost = AppBskyFeedDefs.FeedViewPost;
import { AppBskyFeedPost } from "@atproto/api";

import { ImageOrigin, ImageRef, localeToTimezone } from "@bsky-affirmative-bot/shared-configs";
import { getPds } from "./getPds.js";
import {
  blobImagesToImageRefs,
  classifyPostThread,
  mentionedDids,
  mentionsDid,
} from "@bsky-affirmative-bot/bot-runtime";
import { agent } from "./agent.js";
import e from "express";

/**
 * 言語コードからタイムゾーンを取得するヘルパー関数
 * Nagi 側の日記スケジューラでも使うので実体は clients に置いてある。
 */
export { getTimezoneFromLang } from "@bsky-affirmative-bot/clients";

/**
 * メンション判定しメンション先のDIDを返す
 * @param {*} record 
 * @returns did or null
 */
export function isMention(record: AppBskyFeedPost.Record) { // Changed Record to AppBskyFeedPost.Record
  return mentionedDids(record)[0] ?? null;
}

export { mentionsDid };

/**
 * 自分宛てのメンションまたはリプライか判定
 * @param record 
 * @returns 
 */
export function isReplyOrMentionToMe(record: AppBskyFeedPost.Record) { // Changed Record to AppBskyFeedPost.Record
  const botDid = process.env.BSKY_DID;
  if (!botDid) return false;
  const parentDid = record.reply
    ? splitUri(record.reply.parent.uri).did
    : undefined;
  return parentDid === botDid || mentionsDid(record, botDid);
}

/**
 * フィルター対象となるラベルのリスト
 */
export const IGNORE_LABELS = [
  "!hide",
  "!unspecced-takedown",
  "violence",
  "threat",
  "hate",
  "spam",
  "sexual",
  "porn",
  "nudity",
  "toxic"
];

/**
 * フィルター対象となるNGワードのリスト
 */
export const NG_WORDS = [
  // 寄付系のワード
  "donate",
  "donation",
  "donating",
  "gofund.me",
  "paypal.me",
  // 広告
  "ご案内状況",
  // bot投稿
  "【AUTO】",
  // 暴力系のワード
  "kill",
  "die",
  "death",
  "hurt",
  "harm",
  "murder",
  "suicide",
  "stab",
  "shoot",
  // 攻撃的なワード
  "hate",
  "disgusting",
  "trash",
  "garbage",
  "ugly",
  // 暴言
  "shut up",
  "stfu",
  "fuck off",
  "go away",
  "stop replying",
];

/**
 * 無視対象ラベルが含まれているか判定する
 * @param labels ラベルの配列 (authorLabels や postLabels など)
 * @returns 含まれていれば true
 */
export function isIgnoreTarget(labels?: { val: string }[] | null): boolean {
  if (!labels) return false;
  return labels.some(label => IGNORE_LABELS.includes(label.val));
}

/**
 * テキストにNGワードが含まれているか判定する（大文字小文字区別なし、部分一致）
 * @param text 対象のテキスト
 * @returns 含まれていれば true
 */
export function hasNGWord(text?: string | null): boolean {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return NG_WORDS.some(word => lowerText.includes(word.toLowerCase()));
}

/**
 * ポスト（およびその投稿者）が無視対象ラベルを持っているか判定する
 * @param post 
 * @returns 
 */
export function isIgnorePost(post: PostView): boolean {
  if (isIgnoreTarget(post.author.labels)) return true;
  if (isIgnoreTarget(post.labels)) return true;
  return false;
}

/**
 * Nagiからクロスポストされた投稿か判定する。
 * Nagiクライアントがapp.bsky.feed.postに via: "Nagi" を付けており、
 * これらにはNagi側のbotたんが反応するため、Bluesky側では反応しない。
 */
export function isNagiCrosspost(record: AppBskyFeedPost.Record | any): boolean {
  return record?.via === "Nagi";
}

/**
 * URIをDID/NSID/RKEYに分割
 */
export function splitUri(uri: string) {
  const parts = uri.split('/');

  const did = parts[2];
  const nsid = parts[3];
  const rkey = parts[4];

  return { did, nsid, rkey };
}

/**
 * DID/NSID/RKEYをURIに統合
 * @param did 
 * @param nsid 
 * @param rkey 
 * @returns 
 */
export function uniteDidNsidRkey(did: string, nsid: string, rkey: string) {
  return `at://${did}/${nsid}/${rkey}`;
}

/**
 * 言語判定。返すのは言語名（ex. "日本語, English"）
 * langsが1つならその言語を返し、複数または非設定なら英語を返す
 * Nagi 側の日記でも使うので実体は clients に置いてある。
 */
export { getLangStr } from "@bsky-affirmative-bot/clients";

/**
 * 画像URLを取得
 * 画像、外部リンクOGP画像、動画サムネイルに対応
 * 公式/自前問わずPDSのBlob APIを使用する
 */
export async function getImageUrl(
  did: string,
  embed: any,
  originOverride?: ImageOrigin,
): Promise<ImageRef[]> {
  let result: ImageRef[] = [];

  // PDSエンドポイントを取得
  let pdsEndpoint: string;
  try {
    pdsEndpoint = await getPds(did);
    pdsEndpoint = pdsEndpoint.replace(/\/$/, ""); // 末尾のスラッシュを削除
  } catch (e) {
    console.warn(`Failed to get PDS for ${did}, falling back to CDN assumption`, e);
    pdsEndpoint = "https://bsky.social"; // fallback
  }

  if (AppBskyEmbedImages.isMain(embed)) {
    result.push(
      ...blobImagesToImageRefs(
        did,
        pdsEndpoint,
        (embed as AppBskyEmbedImages.Main).images,
      ).map((image) => ({
        ...image,
        origin: originOverride ?? "direct" as const,
      })),
    );
  } else if (AppBskyEmbedExternal.isMain(embed)) {
    const thumb = (embed as AppBskyEmbedExternal.Main).external.thumb;
    if (thumb) {
      const cid = (thumb.ref as any).$link ?? thumb.ref?.toString(); // ref or IPLD
      const image_url = `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${cid}`; // 回避策
      const mimeType = thumb.mimeType;
      result.push({
        image_url,
        mimeType,
        origin: originOverride ?? "link-preview",
      });
    }
  } else if (AppBskyEmbedVideo.isMain(embed)) {
    const video = (embed as AppBskyEmbedVideo.Main).video;
    if (video) {
      const cid = (video.ref as any).$link ?? video.ref?.toString(); // ref or IPLD
      const image_url = `https://video.bsky.app/watch/${did}/${cid}/thumbnail.jpg`; // 回避策
      const mimeType = "image/jpeg"; // 動画のサムネイルはJPEG
      result.push({
        image_url,
        mimeType,
        origin: originOverride ?? "video-thumbnail",
      });
    }
  } else if (AppBskyEmbedRecordWithMedia.isMain(embed)) {
    const media = (embed as AppBskyEmbedRecordWithMedia.Main).media;
    if (AppBskyEmbedImages.isMain(media) || AppBskyEmbedExternal.isMain(media) || AppBskyEmbedVideo.isMain(media)) {
      const mediaImages = await getImageUrl(did, media, originOverride);
      result.push(...mediaImages);
    }
  }

  return result;
}

/**
 * タイムゾーンを考慮した YYYY-MM-DD 形式の日付文字列を返す
 */
export function formatYMD(date: Date, lang?: string): string {
  const tz = localeToTimezone[lang ?? ""] ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz,
  }).formatToParts(date);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

export { sanitizeDidToLexiconValue } from '@bsky-affirmative-bot/shared-configs';

/**
 * 第三者（ボット自身でも投稿者自身でもない）がスレッドルートである返信か判定する
 * その場合のみ true を返す（機能ブロック対象）
 */
export function isReplyInThirdPartyThread(
  record: AppBskyFeedPost.Record,
  authorDid: string
): boolean {
  if (!record.reply) return false;
  const botDid = process.env.BSKY_DID;
  if (!botDid) return true;
  const kind = classifyPostThread(record, authorDid, botDid);
  return kind === "third-party-thread" || kind === "bot-thread-third-party";
}

/**
 * アフィリエイトドメインリスト
 */
export const AFFILIATE_DOMAINS = [
  // 国内
  'a8.net', 'px.a8.net',
  'afl.rakuten.co.jp', 'hb.afl.rakuten.co.jp',
  'af.moshimo.com',
  'ck.jp.ap.valuecommerce.com',
  'amzn.to',
  // 海外
  'shareasale.com',
  'awin1.com', 'awinmid.com',
  'pjatr.com',
  'anrdoezrs.net', 'dpbolvw.net', 'jdoqocy.com', 'kqzyfj.com', 'tkqlhce.com', // CJ
  'clkbank.com', 'hop.clickbank.net',
  'impactradius-go.com',
  'go.skimresources.com',
  'rstyle.me',
  'linksynergy.com'
];

/**
 * 配信ドメインリスト
 */
export const BROADCAST_DOMAINS = [
  'twitch.tv', 'www.twitch.tv',
  'youtube.com', 'www.youtube.com', 'youtu.be',
  'nba.com', 'www.nba.com',
  'nba.smart.link',
  'espn.com', 'www.espn.com',
  'stream.place',
  'skylight.social',
  'bluecast.app', 'www.bluecast.app'
];

/**
 * ポスト（およびその外部埋め込み）からドメインの一覧を取得する
 * @param record ポストのレコード
 */
export function getDomainsFromPost(record: AppBskyFeedPost.Record | any): string[] {
  const urls: string[] = [];
  if (record?.facets) {
    for (const facet of record.facets) {
      if (facet.features) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#link' && typeof feature.uri === 'string') {
            urls.push(feature.uri);
          }
        }
      }
    }
  }
  if (record?.embed) {
    const embed = record.embed as any;
    
    // 外部埋め込みのリンクを抽出するヘルパー
    const extractFromExternal = (ext: any) => {
      if (ext && typeof ext.uri === 'string') {
        urls.push(ext.uri);
      }
    };

    if (embed.$type === 'app.bsky.embed.external') {
      extractFromExternal(embed.external);
    } else if (embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media) {
      if (embed.media.$type === 'app.bsky.embed.external') {
        extractFromExternal(embed.media.external);
      } else if (embed.media.external) {
        extractFromExternal(embed.media.external);
      }
    } else if (embed.external) {
      extractFromExternal(embed.external);
    }
  }

  const domains = urls.map(url => {
    try {
      let formattedUrl = url;
      if (!/^https?:\/\//i.test(url)) {
        formattedUrl = 'https://' + url;
      }
      const parsed = new URL(formattedUrl);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }).filter(domain => domain !== '');

  return domains;
}

/**
 * ドメインが指定されたリスト内のいずれかに一致するか判定する
 * @param domain 対象ドメイン
 * @param list ドメインリスト
 */
export function matchesDomainList(domain: string, list: string[]): boolean {
  const normalizedDomain = domain.toLowerCase();
  return list.some(item => {
    const normalizedItem = item.toLowerCase();
    return normalizedDomain === normalizedItem || normalizedDomain.endsWith('.' + normalizedItem);
  });
}

/**
 * 配信ドメインリンクが含まれているか判定する
 */
export function hasBroadcastDomainLink(record: AppBskyFeedPost.Record | any): boolean {
  const domains = getDomainsFromPost(record);
  return domains.some(domain => matchesDomainList(domain, BROADCAST_DOMAINS));
}

/**
 * アフィリエイトドメインリンクが含まれているか判定する
 */
export function hasAffiliateDomainLink(record: AppBskyFeedPost.Record | any): boolean {
  const domains = getDomainsFromPost(record);
  return domains.some(domain => matchesDomainList(domain, AFFILIATE_DOMAINS));
}

/**
 * ポストに何らかの外部リンク（facetリンクまたは外部埋め込み）が含まれているか判定する
 */
export function hasAnyLink(record: AppBskyFeedPost.Record | any): boolean {
  if (record?.facets) {
    for (const facet of record.facets) {
      if (facet.features) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#link') {
            return true;
          }
        }
      }
    }
  }
  if (record?.embed) {
    const embed = record.embed as any;
    if (embed.$type === 'app.bsky.embed.external' || !!embed.external) {
      return true;
    }
    if (embed.$type === 'app.bsky.embed.recordWithMedia' && embed.media) {
      if (embed.media.$type === 'app.bsky.embed.external' || !!embed.media.external) {
        return true;
      }
    }
  }
  return false;
}

/**
 * ユーザーの最新の通常ポスト（リプライ・リポスト・メンション・NGワード除く）を返す
 */
export async function getLatestPostOf(did: string): Promise<FeedViewPost | null> {
  const response = await agent.getAuthorFeed({ actor: did, filter: 'posts_no_replies' });
  for (const feed of response.data.feed) {
    const postRecord = feed.post.record as AppBskyFeedPost.Record;
    if (!isMention(postRecord) && !feed.reason && !isIgnorePost(feed.post) && !hasNGWord(postRecord.text)) {
      return feed;
    }
  }
  return null;
}
