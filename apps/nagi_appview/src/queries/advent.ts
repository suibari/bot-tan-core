import {
  db,
  nagiActors,
  nagiAdventCards,
  nagiAdventReadStates,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import type {
  AdventCalendarView,
  AdventCardView,
  AdventReadState,
  PutAdventReadInput,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  ADVENT_DAYS,
  adventOpenedDay,
  adventPublishAt,
  adventYear,
  isAdventDay,
} from "@bsky-affirmative-bot/shared-configs";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";

/** 受け付ける年の範囲。初回は 2026 年。 */
const ADVENT_MIN_YEAR = 2026;

const avatarUrl = (did: string, cid: string | null | undefined) =>
  cid ? `/api/blob/${encodeURIComponent(did)}/${cid}` : undefined;

export function parseAdventYear(value: unknown, now = new Date()): number {
  if (value === undefined || value === "") return adventYear(now);
  const year = Number(value);
  if (!Number.isInteger(year) || year < ADVENT_MIN_YEAR || year > adventYear(now))
    throw new ApiError(400, "invalid_request", "Invalid year");
  return year;
}

/**
 * アドベントカレンダー。公開時刻を過ぎたカードだけを返す（未公開の行は存在も漏らさない）。
 *
 * 名前とアバターは現在のプロフィールを優先し、引けなければ選んだ時点の控えを使う。
 * 元のポストが消えていても、カードは控えのまま残す（カレンダーに空欄を作らない）。
 */
export async function getAdventCalendar(
  year: number,
  now = new Date(),
): Promise<AdventCalendarView> {
  const rows = await db
    .select({
      card: nagiAdventCards,
      handle: nagiActors.handle,
      actorStatus: nagiActors.status,
      displayName: nagiProfiles.displayName,
      avatarCid: nagiProfiles.avatarCid,
      postUri: nagiPosts.uri,
    })
    .from(nagiAdventCards)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiAdventCards.did))
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiAdventCards.did))
    .leftJoin(
      nagiPosts,
      and(eq(nagiPosts.uri, nagiAdventCards.postUri), isNull(nagiPosts.deletedAt)),
    )
    .where(and(eq(nagiAdventCards.year, year), lte(nagiAdventCards.publishAt, now)))
    .orderBy(asc(nagiAdventCards.day));

  const cards: AdventCardView[] = rows.map((row) => {
    const live = row.actorStatus === "active" && row.displayName !== null;
    return {
      year,
      day: row.card.day,
      actor: {
        did: row.card.did,
        handle: (live && row.handle) || row.card.handle,
        displayName: (live && row.displayName) || row.card.displayName,
        avatar: avatarUrl(row.card.did, live ? row.avatarCid : row.card.avatarCid),
      },
      ...(row.postUri ? { postUri: row.postUri } : {}),
      titleJa: row.card.titleJa,
      titleEn: row.card.titleEn,
      commentJa: row.card.commentJa,
      commentEn: row.card.commentEn,
      publishedAt: row.card.publishAt.toISOString(),
    };
  });

  const openedDay = adventOpenedDay(year, now);
  return {
    year,
    openedDay,
    ...(openedDay < ADVENT_DAYS
      ? { nextOpenAt: adventPublishAt(year, openedDay + 1).toISOString() }
      : {}),
    cards,
  };
}

export async function getAdventReadState(
  did: string,
  now = new Date(),
): Promise<AdventReadState | undefined> {
  const year = adventYear(now);
  const [row] = await db
    .select()
    .from(nagiAdventReadStates)
    .where(and(eq(nagiAdventReadStates.did, did), eq(nagiAdventReadStates.year, year)))
    .limit(1);
  if (!row) return undefined;
  return { year, lastSeenDay: row.lastSeenDay, openedDays: [...row.openedDays].sort((a, b) => a - b) };
}

export function parseAdventReadInput(
  input: unknown,
  now = new Date(),
): PutAdventReadInput | undefined {
  if (input === undefined) return undefined;
  const invalid = () => new ApiError(400, "invalid_request", "Invalid adventRead");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const { year, lastSeenDay, openedDay } = input as Record<string, unknown>;
  if (year !== adventYear(now)) throw invalid();
  const opened = adventOpenedDay(year, now);
  // まだ開いていない日は既読にも開封済みにもできない。
  if (
    lastSeenDay !== undefined &&
    (!Number.isInteger(lastSeenDay) || (lastSeenDay as number) < 0 || (lastSeenDay as number) > opened)
  )
    throw invalid();
  if (openedDay !== undefined && (!isAdventDay(openedDay) || openedDay > opened)) throw invalid();
  return {
    year,
    ...(lastSeenDay !== undefined ? { lastSeenDay: lastSeenDay as number } : {}),
    ...(openedDay !== undefined ? { openedDay } : {}),
  };
}

/** 既読の日は前にしか進めない。開封済みの日は足すだけ。 */
export async function putAdventReadState(did: string, input: PutAdventReadInput) {
  const lastSeenDay = input.lastSeenDay ?? 0;
  const opened = input.openedDay ? [input.openedDay] : [];
  await db
    .insert(nagiAdventReadStates)
    .values({ did, year: input.year, lastSeenDay, openedDays: opened })
    .onConflictDoUpdate({
      target: [nagiAdventReadStates.did, nagiAdventReadStates.year],
      set: {
        lastSeenDay: sql`GREATEST(${nagiAdventReadStates.lastSeenDay}, ${lastSeenDay})`,
        openedDays: opened.length
          ? sql`(select coalesce(array_agg(distinct d order by d), '{}') from unnest(array_cat(${nagiAdventReadStates.openedDays}, ARRAY[${opened[0]}]::integer[])) as d)`
          : sql`${nagiAdventReadStates.openedDays}`,
        updatedAt: sql`now()`,
      },
    });
}
