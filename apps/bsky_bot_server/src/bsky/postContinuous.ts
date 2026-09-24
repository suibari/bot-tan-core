import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { $Typed, AppBskyEmbedRecord, AppBskyEmbedExternal, BlobRef } from "@atproto/api";
import { post } from "./post.js";
import { ComAtprotoRepoStrongRef } from "@atproto/api"; type Main = ComAtprotoRepoStrongRef.Main;
import { POST_TEXT_LIMIT } from "@bsky-affirmative-bot/shared-configs";

/**
 * 300文字以上のポストの場合、自動で分割投稿する
 * @param embedTo 引用ポスト先のレコード。連続ポストの最初のポストで引用される
 */
export async function postContinuous(
  text: string,
  replyTo?: {
    uri: string,
    cid: string,
    record: Record,
  },
  image?: {
    blob: BlobRef,
    alt: string,
  },
  embedTo?: {
    uri: string,
    cid: string,
  },
  external?: AppBskyEmbedExternal.External,
  postImpl: typeof post = post,
): Promise<{ uri: string; cid: string; }> {
  // ポスト制限文字数以上の場合は切り詰める
  if (text.length > POST_TEXT_LIMIT) {
    console.warn(`[WARN] Post text exceeded POST_TEXT_LIMIT (${text.length} > ${POST_TEXT_LIMIT}). Truncating...`);
    text = text.slice(0, POST_TEXT_LIMIT);
  }

  const MAX_LENGTH = 300;
  const parts = splitTextSmart(text, MAX_LENGTH);

  let root: Main | undefined = undefined;
  let parentPost: Main | undefined = undefined;
  let firstPostResult: { uri: string; cid: string; } | undefined = undefined;

  // replyToの内容によってroot/parentPostを決定
  if (replyTo) {
    const { uri, cid, record } = replyTo;
    if (record.reply) {
      // 3. リプライツリー投稿
      root = record.reply.root;
      parentPost = { uri, cid };
    } else {
      // 2. 通常ポストへの返信
      root = { uri, cid };
      parentPost = { uri, cid };
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const currentText = parts[i];
    const isFirst = i === 0;

    const newRecord: Record = {
      $type: 'app.bsky.feed.post',
      text: currentText,
      createdAt: new Date().toISOString()
    };

    // リプライ構造の設定
    if (replyTo) {
      if (isFirst) {
        newRecord.reply = {
          root: root!,
          parent: parentPost!
        };
      } else {
        newRecord.reply = {
          root: root!,
          parent: parentPost!
        };
      }
    } else if (!replyTo && !isFirst) {
      // 1. replyToなしで2個目以降 → 自分の1個目がroot
      if (!root || !parentPost) {
        throw new Error("rootまたはparentPostが未定義です（自己連投時）");
      }
      newRecord.reply = {
        root,
        parent: parentPost
      };
    }

    // NOTE: RecordWithMediaを使えば画像と引用を同時ポストできるが、未対応
    // 初回投稿に画像を添付
    if (isFirst && image) {
      newRecord.embed = {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: image.blob,
            alt: image.alt ?? "全肯定botより",
          }
        ]
      };
    }

    // 初回投稿に引用をセット
    if (isFirst && embedTo) {
      const embedRecord: $Typed<AppBskyEmbedRecord.Main> = {
        $type: 'app.bsky.embed.record',
        record: {
          uri: embedTo.uri,
          cid: embedTo.cid,
        }
      }
      newRecord.embed = embedRecord;
    }

    if (isFirst && external && !newRecord.embed) {
      newRecord.embed = { $type: "app.bsky.embed.external", external };
    }

    const result = await postImpl(newRecord);
    if (isFirst) {
      firstPostResult = result;
    }
    parentPost = result;

    // 1. 最初の投稿がrootになるケース
    if (isFirst && !replyTo) {
      root = result;
    }
  }

  return firstPostResult!;
}

type Token = {
  type: 'url' | 'text';
  content: string;
};

type Element =
  | { type: 'url'; text: string }
  | { type: 'char'; text: string };

function splitTextSmart(text: string, MAX_LENGTH: number): string[] {
  // 1. URLs and normal text tokenization
  const tokens: Token[] = [];
  const URL_REGEX = /https?:\/\/[^\s]+/g;
  const matches = [...text.matchAll(URL_REGEX)];

  let lastIndex = 0;
  for (const match of matches) {
    const index = match.index!;
    const url = match[0];

    if (index > lastIndex) {
      tokens.push({ type: 'text', content: text.slice(lastIndex, index) });
    }

    tokens.push({ type: 'url', content: url });
    lastIndex = index + url.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', content: text.slice(lastIndex) });
  }

  // 2. Fragment plain text into graphemes, keeping URLs as single elements
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  const elements: Element[] = [];

  for (const token of tokens) {
    if (token.type === 'url') {
      elements.push({ type: 'url', text: token.content });
    } else {
      const graphemes = Array.from(segmenter.segment(token.content), s => s.segment);
      for (const g of graphemes) {
        elements.push({ type: 'char', text: g });
      }
    }
  }

  // 3. Reconstruct the parts while respecting the length constraint and URL integrity
  const parts: string[] = [];
  let buffer = '';

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];

    if ((buffer + el.text).length <= MAX_LENGTH) {
      buffer += el.text;
      continue;
    }

    if (el.type === 'url') {
      // Never cut a URL. Flush current buffer and start next post with the URL
      if (buffer.length > 0) {
        parts.push(buffer);
        buffer = el.text;
      } else {
        // Failsafe: if a single URL exceeds MAX_LENGTH, keep it whole
        buffer = el.text;
      }
    } else {
      // Normal character splitting. Avoid splitting in the middle of words, tags, or mentions.
      let safeEnd = buffer.length;
      const match = buffer.match(/(https?:\/\/[^\s]+|[a-zA-Z0-9_]+|@[^\s]+|#[^\s]+)$/);

      if (match) {
        const unsafeLen = match[0].length;
        safeEnd -= unsafeLen;

        if (safeEnd <= 0) {
          parts.push(buffer);
          buffer = el.text;
        } else {
          parts.push(buffer.slice(0, safeEnd));
          buffer = buffer.slice(safeEnd) + el.text;
        }
      } else {
        parts.push(buffer);
        buffer = el.text;
      }
    }
  }

  if (buffer) {
    parts.push(buffer);
  }

  return parts;
}
