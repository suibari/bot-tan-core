import { startWorkerLoop } from "@bsky-affirmative-bot/bot-runtime";
import {
  captionEmoji,
  isEmojiCaptionRouteLocal,
} from "@bsky-affirmative-bot/bot-brain/emoji-caption";
import { isOllamaConfigured } from "@bsky-affirmative-bot/bot-brain/ollama-chat";
import {
  createEmbeddingRetryBackoff,
  db,
  nagiEmojis,
} from "@bsky-affirmative-bot/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { isNormalizedBluemojiFormats } from "./validateRecord.js";
import { formatEmojiSearchText } from "../services/emojiSearchText.js";
import { resolvePdsUrl } from "../util/pds.js";

/**
 * カスタム絵文字の画像から検索用の文字と連想語を読み取り、search_text に書く。
 *
 * ジョブ表は持たず `search_text_cid IS DISTINCT FROM cid` を拾う（EmbeddingWorker と同じ方式）。
 * 新規・既存のバックフィル・画像の差し替え（cid 変化）が同じ経路で処理される。
 * search_text を書くときに embedding を NULL に戻し、EmbeddingWorker に作り直させる。
 *
 * 1件ずつ直列で回す。共有の Ollama を叩くので並列にしない（startWorkerLoop が重ならない）。
 */

/**
 * 1件あたり実測 3〜4 秒（2026-10-28、gemma-4-12B）。返信生成と同じ Ollama を使うので、
 * 1 tick を短く切って間に他の生成が入れるようにする。本番 1,112件のバックフィルは2時間弱。
 */
const BATCH_SIZE = 3;
const INTERVAL_MS = 10_000;
const ASSET_FETCH_TIMEOUT_MS = 10_000;
/** 絵文字の資産は 128px 前後。大きすぎるものはデコードせず名前だけで読む。 */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const backoff = createEmbeddingRetryBackoff();

type PendingEmoji = {
  uri: string;
  cid: string;
  did: string;
  name: string;
  alt: string | null;
  formats: unknown;
};

/** 画像の実バイト。Lottie や取得失敗は undefined（名前だけで読む）。 */
async function loadEmojiImage(
  row: PendingEmoji,
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
  if (!isNormalizedBluemojiFormats(row.formats)) return undefined;
  const { asset } = row.formats;
  if (!asset.mediaType.startsWith("image/")) return undefined;
  if (asset.kind === "bytes") {
    const buffer = Buffer.from(asset.value, "base64");
    return buffer.byteLength <= MAX_ASSET_BYTES
      ? { buffer, mimeType: asset.mediaType }
      : undefined;
  }
  const url = await resolvePdsUrl(row.did);
  url.pathname = "/xrpc/com.atproto.sync.getBlob";
  url.searchParams.set("did", row.did);
  url.searchParams.set("cid", asset.value);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS),
  });
  // PDS の一時的な不調で名前だけの読み取りを確定させない。失敗として後で再試行する。
  if (!response.ok) throw new Error(`emoji asset HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.byteLength <= MAX_ASSET_BYTES
    ? { buffer, mimeType: asset.mediaType }
    : undefined;
}

export async function captionPendingEmojis(): Promise<number> {
  const rows = await db
    .select({
      uri: nagiEmojis.uri,
      cid: nagiEmojis.cid,
      did: nagiEmojis.did,
      name: nagiEmojis.name,
      alt: nagiEmojis.alt,
      formats: nagiEmojis.formats,
    })
    .from(nagiEmojis)
    .where(
      and(
        eq(nagiEmojis.adultOnly, false),
        sql`${nagiEmojis.searchTextCid} is distinct from ${nagiEmojis.cid}`,
      ),
    )
    .orderBy(desc(nagiEmojis.indexedAt))
    .limit(BATCH_SIZE + backoff.size());

  let done = 0;
  for (const row of rows.filter((r) => !backoff.blocked(r.uri)).slice(0, BATCH_SIZE)) {
    try {
      const caption = await captionEmoji({
        name: row.name,
        alt: row.alt,
        image: await loadEmojiImage(row),
      });
      await db
        .update(nagiEmojis)
        .set({
          searchText: formatEmojiSearchText(caption),
          searchTextCid: row.cid,
          embedding: null,
        })
        // 読み取り中に画像が差し替わっていたら書かない（次の回に新しい cid で読み直す）。
        .where(and(eq(nagiEmojis.uri, row.uri), eq(nagiEmojis.cid, row.cid)));
      backoff.succeed(row.uri);
      done++;
    } catch (error) {
      backoff.fail(row.uri);
      console.warn(
        "[WARN][EMOJI_CAPTION] failed",
        row.uri,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return done;
}

/** Ollama 未設定、またはルートがローカルでなければ起動しない。 */
export function startEmojiCaptionWorker(): NodeJS.Timeout | undefined {
  if (!isOllamaConfigured() || !isEmojiCaptionRouteLocal()) {
    console.info("[EMOJI_CAPTION] disabled (local Ollama route is not configured)");
    return undefined;
  }
  const timer = startWorkerLoop({
    name: "EMOJI_CAPTION",
    intervalMs: INTERVAL_MS,
    immediate: true,
    tick: () => captionPendingEmojis(),
  });
  timer.unref();
  return timer;
}
