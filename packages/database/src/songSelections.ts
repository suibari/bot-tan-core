import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { bot_song_selections, db } from "./db.js";

export const BOT_SONG_SELECTION_COOLDOWN_DAYS = 30;

export type BotSongSelectionScope =
  | { purpose: "scheduled_post"; subjectDid?: undefined }
  | { purpose: "dj"; subjectDid: string };

export const SCHEDULED_POST_SONG_SCOPE = {
  purpose: "scheduled_post",
} as const satisfies BotSongSelectionScope;

export function djSongSelectionScope(subjectDid: string): BotSongSelectionScope {
  if (!subjectDid.startsWith("did:")) throw new Error("DJ song selection scope requires a DID");
  return { purpose: "dj", subjectDid };
}

export function botSongSelectionScopeKey(scope: BotSongSelectionScope) {
  return scope.purpose === "dj" ? `dj\u0000${scope.subjectDid}` : "scheduled_post";
}

export interface BotSongSelection {
  videoId: string;
  songKey: string;
  title: string;
  artist: string;
  purpose: BotSongSelectionScope["purpose"];
  subjectDid: string | null;
  outputRef: string | null;
  selectedAt: Date;
}

export interface NewBotSongSelection {
  videoId: string;
  songKey: string;
  title: string;
  artist: string;
  scope: BotSongSelectionScope;
  outputRef?: string;
}

export function botSongSelectionCutoff(
  now = new Date(),
  cooldownDays = BOT_SONG_SELECTION_COOLDOWN_DAYS,
) {
  return new Date(now.getTime() - cooldownDays * 24 * 60 * 60 * 1_000);
}

export async function getRecentBotSongSelections(
  scope: BotSongSelectionScope,
  since: Date,
): Promise<BotSongSelection[]> {
  const rows = await buildRecentBotSongSelectionsQuery(scope, since);
  return rows.map((row) => ({
    videoId: row.video_id,
    songKey: row.song_key,
    title: row.title,
    artist: row.artist,
    purpose: row.purpose as BotSongSelectionScope["purpose"],
    subjectDid: row.subject_did,
    outputRef: row.output_ref,
    selectedAt: row.selected_at,
  }));
}

export function buildRecentBotSongSelectionsQuery(
  scope: BotSongSelectionScope,
  since: Date,
) {
  const subjectCondition = scope.purpose === "dj"
    ? eq(bot_song_selections.subject_did, scope.subjectDid)
    : isNull(bot_song_selections.subject_did);
  return db
    .select()
    .from(bot_song_selections)
    .where(and(
      eq(bot_song_selections.purpose, scope.purpose),
      subjectCondition,
      gte(bot_song_selections.selected_at, since),
    ))
    .orderBy(desc(bot_song_selections.selected_at));
}

export async function recordBotSongSelection(selection: NewBotSongSelection) {
  await db.insert(bot_song_selections).values({
    video_id: selection.videoId,
    song_key: selection.songKey,
    title: selection.title,
    artist: selection.artist,
    purpose: selection.scope.purpose,
    subject_did: selection.scope.purpose === "dj" ? selection.scope.subjectDid : null,
    output_ref: selection.outputRef ?? null,
  });
}
