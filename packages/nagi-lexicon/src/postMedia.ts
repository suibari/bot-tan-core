import { NAGI } from "./constants.js";

/**
 * 投稿の embed から画像と動画を取り出す。読み手はここを通すこと。
 *
 * メディアの置き場所は embed の型ごとに違う:
 * - `#images`  … `images`
 * - `#video`   … embed 自体が動画
 * - `#gallery` … `items` に `#image` / `#video` が混ざる
 * - `#quote`   … `images` / `video` を持てる
 *
 * 型ごとの分岐を各所に書くと、型が増えたときに読み漏れる（#gallery を足したときがそう）。
 * 返す値は `$type` を落とした中身で、DB の `embed_images` / `embed_video` に入る形と同じ。
 * 中身の妥当性はここでは見ない。レコードの検証は AppView の validateRecord が持つ。
 */
export function nagiPostMedia(embed: unknown): { images: any[]; video: any | null } {
  const value = embed as any;
  switch (value?.$type) {
    case `${NAGI.post}#images`:
      return { images: Array.isArray(value.images) ? value.images : [], video: null };
    case `${NAGI.post}#video`: {
      const { $type: _type, ...video } = value;
      return { images: [], video };
    }
    case `${NAGI.post}#gallery`: {
      const items: any[] = Array.isArray(value.items) ? value.items : [];
      const images: any[] = [];
      let video: any = null;
      for (const item of items) {
        const { $type: type, ...rest } = item ?? {};
        if (type === `${NAGI.post}#image`) images.push(rest);
        // 動画は1本まで（validateRecord で保証）。崩れたレコードでも先頭だけ使う。
        else if (type === `${NAGI.post}#video` && !video) video = rest;
      }
      return { images, video };
    }
    case `${NAGI.post}#quote`:
      return {
        images: Array.isArray(value.images) ? value.images : [],
        video: value.video ?? null,
      };
    default:
      return { images: [], video: null };
  }
}
