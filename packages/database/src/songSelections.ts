import { desc, gte } from "drizzle-orm";
import { bot_song_selections, db } from "./db.js";

export const BOT_SONG_SELECTION_COOLDOWN_DAYS = 30;

export type BotSongSelectionSource = "scheduled_post" | "dj";

export interface BotSongSelection {
  videoId: string;
  songKey: string;
  title: string;
  artist: string;
  source: BotSongSelectionSource;
  outputRef: string | null;
  selectedAt: Date;
}

export interface NewBotSongSelection {
  videoId: string;
  songKey: string;
  title: string;
  artist: string;
  source: BotSongSelectionSource;
  outputRef?: string;
}

export function botSongSelectionCutoff(
  now = new Date(),
  cooldownDays = BOT_SONG_SELECTION_COOLDOWN_DAYS,
) {
  return new Date(now.getTime() - cooldownDays * 24 * 60 * 60 * 1_000);
}

export async function getRecentBotSongSelections(
  since: Date,
): Promise<BotSongSelection[]> {
  const rows = await buildRecentBotSongSelectionsQuery(since);
  return rows.map((row) => ({
    videoId: row.video_id,
    songKey: row.song_key,
    title: row.title,
    artist: row.artist,
    source: row.source as BotSongSelectionSource,
    outputRef: row.output_ref,
    selectedAt: row.selected_at,
  }));
}

export function buildRecentBotSongSelectionsQuery(since: Date) {
  return db
    .select()
    .from(bot_song_selections)
    .where(gte(bot_song_selections.selected_at, since))
    .orderBy(desc(bot_song_selections.selected_at));
}

export async function recordBotSongSelection(selection: NewBotSongSelection) {
  await db.insert(bot_song_selections).values({
    video_id: selection.videoId,
    song_key: selection.songKey,
    title: selection.title,
    artist: selection.artist,
    source: selection.source,
    output_ref: selection.outputRef ?? null,
  });
}
