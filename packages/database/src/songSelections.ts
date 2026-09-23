import { and, desc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import { bot_song_selections, db } from "./db.js";

export const BOT_SONG_SELECTION_COOLDOWN_DAYS = 30;
export const BOT_SONG_RESERVATION_TTL_MS = 15 * 60 * 1_000;

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
  status: "reserved" | "published";
  reservationExpiresAt: Date | null;
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

export interface BotSongReservation {
  id: number;
  videoId: string;
  songKey: string;
  scope: BotSongSelectionScope;
  selectedAt: Date;
  expiresAt: Date;
}

export function botSongSelectionCutoff(
  now = new Date(),
  cooldownDays = BOT_SONG_SELECTION_COOLDOWN_DAYS,
) {
  return new Date(now.getTime() - cooldownDays * 24 * 60 * 60 * 1_000);
}

/** ちょうど30日前は範囲内。未来時刻は履歴として扱わない。 */
export function isBotSongSelectionWithinCooldown(selectedAt: Date, now = new Date()) {
  return selectedAt >= botSongSelectionCutoff(now) && selectedAt <= now;
}

const scopeCondition = (scope: BotSongSelectionScope) => and(
  eq(bot_song_selections.purpose, scope.purpose),
  scope.purpose === "dj"
    ? eq(bot_song_selections.subject_did, scope.subjectDid)
    : isNull(bot_song_selections.subject_did),
);

const activeSelectionCondition = (now: Date) => or(
  and(
    eq(bot_song_selections.status, "published"),
    gte(bot_song_selections.selected_at, botSongSelectionCutoff(now)),
    lte(bot_song_selections.selected_at, now),
  ),
  and(
    eq(bot_song_selections.status, "reserved"),
    gt(bot_song_selections.reservation_expires_at, now),
  ),
);

export async function getRecentBotSongSelections(
  scope: BotSongSelectionScope,
  now = new Date(),
): Promise<BotSongSelection[]> {
  const rows = await buildRecentBotSongSelectionsQuery(scope, now);
  return rows.map((row) => ({
    videoId: row.video_id,
    songKey: row.song_key,
    title: row.title,
    artist: row.artist,
    purpose: row.purpose as BotSongSelectionScope["purpose"],
    subjectDid: row.subject_did,
    outputRef: row.output_ref,
    status: row.status as BotSongSelection["status"],
    reservationExpiresAt: row.reservation_expires_at,
    selectedAt: row.selected_at,
  }));
}

export function buildRecentBotSongSelectionsQuery(scope: BotSongSelectionScope, now: Date) {
  return db
    .select()
    .from(bot_song_selections)
    .where(and(scopeCondition(scope), activeSelectionCondition(now)))
    .orderBy(desc(bot_song_selections.selected_at));
}

/** 同じスコープの判定と挿入を直列化し、投稿前に曲を確保する。 */
export async function reserveBotSongSelection(
  selection: Omit<NewBotSongSelection, "outputRef">,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<BotSongReservation | null> {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? BOT_SONG_RESERVATION_TTL_MS));
  const lockKey = `bot-song-selection-v1:${botSongSelectionScopeKey(selection.scope)}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx.delete(bot_song_selections).where(and(
      eq(bot_song_selections.status, "reserved"),
      lte(bot_song_selections.reservation_expires_at, now),
    ));

    const [conflict] = await tx
      .select({ id: bot_song_selections.id })
      .from(bot_song_selections)
      .where(and(
        scopeCondition(selection.scope),
        activeSelectionCondition(now),
        or(
          eq(bot_song_selections.video_id, selection.videoId),
          eq(bot_song_selections.song_key, selection.songKey),
        ),
      ))
      .limit(1);
    if (conflict) return null;

    const [row] = await tx.insert(bot_song_selections).values({
      video_id: selection.videoId,
      song_key: selection.songKey,
      title: selection.title,
      artist: selection.artist,
      purpose: selection.scope.purpose,
      subject_did: selection.scope.purpose === "dj" ? selection.scope.subjectDid : null,
      output_ref: null,
      status: "reserved",
      reservation_expires_at: expiresAt,
      selected_at: now,
    }).returning({ id: bot_song_selections.id });
    if (!row) throw new Error("Failed to insert song reservation");
    return {
      id: row.id,
      videoId: selection.videoId,
      songKey: selection.songKey,
      scope: selection.scope,
      selectedAt: now,
      expiresAt,
    };
  });
}

export async function finalizeBotSongSelection(
  reservation: BotSongReservation,
  outputRef?: string,
) {
  const [row] = await db.update(bot_song_selections).set({
    status: "published",
    reservation_expires_at: null,
    output_ref: outputRef ?? null,
  }).where(and(
    eq(bot_song_selections.id, reservation.id),
    eq(bot_song_selections.status, "reserved"),
  )).returning({ id: bot_song_selections.id });
  if (!row) throw new Error(`Song reservation ${reservation.id} is no longer active`);
}

export async function releaseBotSongSelection(reservation: BotSongReservation) {
  await db.delete(bot_song_selections).where(and(
    eq(bot_song_selections.id, reservation.id),
    eq(bot_song_selections.status, "reserved"),
  ));
}

/** 管理用・バックフィル用。通常の投稿経路はreserve/finalizeを使う。 */
export async function recordBotSongSelection(selection: NewBotSongSelection) {
  await db.insert(bot_song_selections).values({
    video_id: selection.videoId,
    song_key: selection.songKey,
    title: selection.title,
    artist: selection.artist,
    purpose: selection.scope.purpose,
    subject_did: selection.scope.purpose === "dj" ? selection.scope.subjectDid : null,
    output_ref: selection.outputRef ?? null,
    status: "published",
    reservation_expires_at: null,
  });
}
