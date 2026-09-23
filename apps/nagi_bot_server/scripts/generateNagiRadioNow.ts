import { and, eq } from "drizzle-orm";
import { db, nagiActors, nagiRadioTracks } from "@bsky-affirmative-bot/database";
import { searchYoutubeSong, songKey } from "@bsky-affirmative-bot/bot-brain";
import { currentRadioSlotKey } from "@bsky-affirmative-bot/nagi-lexicon";
import { generateNagiRadioForUser } from "../src/NagiRadioWorker.js";

// 開発DBだけで使う本人指定の手動実行。公開APIへ再生成エンドポイントを増やさない。
if (process.env.NODE_ENV !== "development") {
  throw new Error("radio:now requires NODE_ENV=development");
}
const handle = process.argv.find((arg) => arg.startsWith("--handle="))?.slice(9);
if (!handle) throw new Error("Usage: pnpm --filter nagi-bot-server radio:now --handle=example.com");
const title = process.argv.find((arg) => arg.startsWith("--title="))?.slice(8);
const artist = process.argv.find((arg) => arg.startsWith("--artist="))?.slice(9);
if (Boolean(title) !== Boolean(artist)) throw new Error("--title and --artist must be specified together");
const matched = title && artist ? await searchYoutubeSong(title, artist) : null;
if (title && artist && !matched) throw new Error("No official YouTube video for preferred song");
const preferredSong = title && artist && matched
  ? { ...matched, title, artist, songKey: songKey({ title, artist }) }
  : undefined;
const [actor] = await db.select({ did: nagiActors.did })
  .from(nagiActors).where(eq(nagiActors.handle, handle)).limit(1);
if (!actor) throw new Error(`Unknown Nagi handle: ${handle}`);
if (process.argv.includes("--force")) {
  // 検証中に失敗した pending リースや既存の表示を消して、この場で生成し直す。
  await db.delete(nagiRadioTracks).where(and(
    eq(nagiRadioTracks.subjectDid, actor.did),
    eq(nagiRadioTracks.slotKey, currentRadioSlotKey()),
  ));
}
const generated = await generateNagiRadioForUser(actor.did, new Date(), { preferredSong });
const [track] = await db.select({
  slotKey: nagiRadioTracks.slotKey,
  status: nagiRadioTracks.status,
  title: nagiRadioTracks.title,
  artist: nagiRadioTracks.artist,
}).from(nagiRadioTracks).where(and(
  eq(nagiRadioTracks.subjectDid, actor.did),
  eq(nagiRadioTracks.slotKey, currentRadioSlotKey()),
)).limit(1);
console.log(JSON.stringify({ handle, slot: currentRadioSlotKey(), generated, track: track ?? null }));
process.exit(track?.status === "ready" && track.slotKey === currentRadioSlotKey() ? 0 : 1);
