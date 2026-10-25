import {
  BLUEMOJI_ITEM,
  NAGI,
  isAppviewOwnedUri,
  nagiPostMedia,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { appviewPublicUrl as publicUrl } from "../../util/publicUrl.js";
import { nagiVideoUrls } from "../../queries/postVideo.js";
import type { ModerationInput } from "./openai.js";

/**
 * 「他ユーザーに表示されるユーザー生成物」から判定入力を取り出す層。
 *
 * ここに無いコレクションは判定しない。リアクションは参照先の絵文字を判定済みなので
 * 二重に見ない。日記は botたん生成物で別ポリシー、appLinks・下書き・ブックマーク・
 * 設定は本人向けの管理データなので、いずれも外部へ送らない。
 */

/** 判定対象コレクション。ここに無いものは moderationSubject が null を返す。 */
export const MODERATED_COLLECTIONS = [
  NAGI.post,
  NAGI.profile,
  NAGI.channel,
  NAGI.news,
  NAGI.zenkatsu,
  BLUEMOJI_ITEM,
] as string[];

const text = (value: unknown): string[] =>
  typeof value === "string" && value.trim() ? [value] : [];

/** blob は AppView 自身のプロキシ越しに渡す。第三者CDNへ依存しないため。 */
const blobUrl = (did: string, cid: unknown): string[] =>
  typeof cid === "string" && cid
    ? [`${publicUrl()}/api/blob/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`]
    : [];

/**
 * 動画は中身を送れないので、サムネイルを画像1枚として判定する。
 * video.bsky.app から消えた動画も、AppView が PDS の mp4 から作り直して返す。
 */
const videoThumbnailUrl = (did: string, video: any): string[] => {
  const cid = video?.video?.ref?.$link;
  return typeof cid === "string" && cid
    ? [nagiVideoUrls(did, cid).thumbnail]
    : [];
};

/**
 * こっそり投稿は判定しない（OpenAI へ一切送らない）。
 *
 * 経路が3つある（XRPC の createKossoriPost・botたんのこっそり返信・reconcile）ので、
 * 由来の違う3条件すべてを見る。どれか1つでも立てば除外。
 */
export function isKossoriSubject(
  uri: string,
  record: unknown,
  appviewOnly: boolean,
): boolean {
  return (
    appviewOnly ||
    (record as { kossori?: unknown } | null)?.kossori === true ||
    isAppviewOwnedUri(uri)
  );
}

/**
 * 判定入力を組み立てる。対象外のコレクションなら null。
 * 画像 URL は OpenAI が取得できる公開 URL でなければならない。
 */
export function moderationSubject(
  collection: string,
  record: any,
  did: string,
): ModerationInput | null {
  if (!record) return null;
  switch (collection) {
    case NAGI.post: {
      const { images, video } = nagiPostMedia(record.embed);
      return {
        texts: [
          ...text(record.text),
          ...images.flatMap((image) => text(image?.alt)),
          ...text(video?.alt),
          ...text(record.embed?.linkCard?.title),
          ...text(record.embed?.linkCard?.description),
        ],
        imageUrls: [
          ...images.flatMap((image) => blobUrl(did, image?.image?.ref?.$link)),
          ...videoThumbnailUrl(did, video),
        ],
      };
    }
    case NAGI.profile:
      return {
        texts: [...text(record.displayName), ...text(record.description)],
        imageUrls: blobUrl(did, record.avatar?.ref?.$link),
      };
    case NAGI.channel:
      return {
        texts: [...text(record.name), ...text(record.description)],
        imageUrls: blobUrl(did, record.banner?.ref?.$link),
      };
    case NAGI.news:
      // ニュースに画像はない（lexicon に持たせていない）。見出しと出典名だけを見る。
      return {
        texts: [...text(record.titleJa), ...text(record.sourceName)],
        imageUrls: [],
      };
    case NAGI.zenkatsu:
      // 札は定義済みのものしか出せないので、見るのは作者の意図（自由記述）だけ。
      return { texts: text(record.note), imageUrls: [] };
    case BLUEMOJI_ITEM:
      // 資産の実体は blob と inline bytes の両方があり、どちらも同じ配信URLに出る。
      // rkey は URI から取れないのでここでは名前と alt だけを見て、画像は
      // 呼び出し側が emojiAssetUrl() で足す。
      return {
        texts: [...text(record.name), ...text(record.alt)],
        imageUrls: [],
      };
    default:
      return null;
  }
}

/** 絵文字資産の公開 URL。lottie など画像でない資産は判定に回さない。 */
export function emojiAssetUrl(
  did: string,
  rkey: string,
  cid: string,
  mediaType: unknown,
): string[] {
  if (typeof mediaType !== "string" || !mediaType.startsWith("image/"))
    return [];
  return [
    `${publicUrl()}/api/emoji-asset/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}/${encodeURIComponent(cid)}`,
  ];
}
