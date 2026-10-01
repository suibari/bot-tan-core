import { createHash } from "node:crypto";
import { NAGI, type NagiNews } from "@bsky-affirmative-bot/nagi-lexicon";
import { agent } from "./agent.js";
import { trackedPutRecord } from "@bsky-affirmative-bot/clients";
import { ensureNagiBotRecordIndexed } from "./appviewInternal.js";

export type PublishNewsRequest = Omit<NagiNews, "$type">;

export function newsRkey(articleId: string): string {
  return createHash("sha256").update(articleId).digest("hex").slice(0, 32);
}

export async function publishNews(request: PublishNewsRequest) {
  if (!agent.did) throw new Error("Nagi bot is not logged in");
  const record: NagiNews = { $type: NAGI.news, ...request };
  const response = await trackedPutRecord(agent, {
    repo: agent.did,
    collection: NAGI.news,
    rkey: newsRkey(request.articleId),
    record,
    validate: false,
  }, "nagi.news");
  const published = { uri: response.data.uri, cid: response.data.cid };
  // 投稿と同じく Jetstream を待たずに AppView へ載せる（nagiPost.ts の publishNagiPost 参照）。
  await ensureNagiBotRecordIndexed(published);
  return published;
}
