import type { BlobRef } from "@atproto/api";
import { safeFetch, type GeminiResponseResult } from "@bsky-affirmative-bot/shared-configs";
import type { LinkedMoodSong } from "@bsky-affirmative-bot/bot-brain";

/** Last.fm APIで確認したジャケットを使い、ページのOGP取得成否に依存させない。 */
export async function buildDjSongReply(
  song: LinkedMoodSong,
  upload: (data: Uint8Array, mimeType: string) => Promise<BlobRef>,
  fetchImage: typeof safeFetch = safeFetch,
): Promise<GeminiResponseResult> {
  const response = await fetchImage(song.thumbnailUrl);
  if (!response.ok) throw new Error(`DJ album artwork HTTP ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (!mimeType || !["image/jpeg", "image/png", "image/webp"].includes(mimeType))
    throw new Error("DJ album artwork has unsupported content type");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DJ album artwork is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1_000_000) throw new Error("DJ album artwork exceeds blob size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (!bytes) throw new Error("DJ album artwork is empty");
  const thumb = await upload(Buffer.concat(chunks), mimeType);
  return {
    text: `${song.comment}\ntitle: ${song.title}\nartist: ${song.artist}\nSource: Last.fm\n${song.url}`,
    external: {
      uri: song.url, title: `${song.artist} - ${song.title}`, description: "Last.fm", thumb,
    },
  };
}
