import {
  db,
  nagiActors,
  nagiDiaries,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import type { ActorView, DiaryView } from "@bsky-affirmative-bot/nagi-lexicon";
import { localeToTimezone } from "@bsky-affirmative-bot/shared-configs";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  like,
  lt,
  lte,
  ne,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError } from "../middleware/errors.js";
import { config } from "../config.js";

type DiaryRow = typeof nagiDiaries.$inferSelect;
type DiaryInteractionEvent = { targetDid: string; eventAt: Date };

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 371;
const INVOLVED_ACTOR_LIMIT = 10;
const DIARY_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DIARY_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function validateDiaryRange(from: string, to: string): void {
  if (!validDate(from) || !validDate(to) || from > to)
    throw new ApiError(400, "invalid_request", "Invalid diary date range");
  const days =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS +
    1;
  if (days > MAX_RANGE_DAYS)
    throw new ApiError(400, "invalid_request", "Diary date range is too large");
}

/** ある瞬間のIANAタイムゾーンにおけるUTCオフセット。DSTも含めて求める。 */
function timezoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const at = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (
    Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour") % 24,
      at("minute"),
      at("second"),
    ) - instant.getTime()
  );
}

/** 日記とpostCountが使う、対象日ローカル22時までの24時間。 */
export function diaryInteractionWindow(row: DiaryRow): {
  start: Date;
  end: Date;
} {
  const lang = ((row.langs as string[] | null) ?? [])[0];
  const timezone = (lang && localeToTimezone[lang]) || "UTC";
  const naive = Date.parse(`${row.diaryDate}T22:00:00.000Z`);
  let endMs = naive;
  for (let index = 0; index < 2; index++)
    endMs = naive - timezoneOffsetMs(new Date(endMs), timezone);
  return { start: new Date(endMs - DAY_MS), end: new Date(endMs) };
}

export function rankDiaryInteractionActors(
  events: DiaryInteractionEvent[],
  window: { start: Date; end: Date },
  actorDid: string,
  limit = INVOLVED_ACTOR_LIMIT,
): string[] {
  const totals = new Map<string, { count: number; latest: number }>();
  for (const event of events) {
    const at = event.eventAt.getTime();
    if (
      event.targetDid === actorDid ||
      at < window.start.getTime() ||
      at > window.end.getTime()
    )
      continue;
    const current = totals.get(event.targetDid);
    totals.set(event.targetDid, {
      count: (current?.count ?? 0) + 1,
      latest: Math.max(current?.latest ?? 0, at),
    });
  }
  return [...totals]
    .sort(
      ([leftDid, left], [rightDid, right]) =>
        right.count - left.count ||
        right.latest - left.latest ||
        leftDid.localeCompare(rightDid),
    )
    .slice(0, limit)
    .map(([did]) => did);
}

async function loadDiaryInteractions(
  actorDid: string,
  start: Date,
  end: Date,
): Promise<DiaryInteractionEvent[]> {
  const replyTarget = alias(nagiPosts, "diary_reply_target");
  const quoteTarget = alias(nagiPosts, "diary_quote_target");
  const [reactionRows, replyRows, quoteRows] = await Promise.all([
    db
      .select({ targetDid: nagiPosts.did, eventAt: nagiReactions.createdAt })
      .from(nagiReactions)
      .innerJoin(nagiPosts, eq(nagiPosts.uri, nagiReactions.subjectUri))
      .where(
        and(
          eq(nagiReactions.did, actorDid),
          ne(nagiPosts.did, actorDid),
          gte(nagiReactions.createdAt, start),
          lte(nagiReactions.createdAt, end),
        ),
      ),
    db
      .select({
        targetDid: replyTarget.did,
        eventAt: nagiPosts.recordCreatedAt,
      })
      .from(nagiPosts)
      .innerJoin(replyTarget, eq(replyTarget.uri, nagiPosts.replyParentUri))
      .where(
        and(
          eq(nagiPosts.did, actorDid),
          ne(replyTarget.did, actorDid),
          gte(nagiPosts.recordCreatedAt, start),
          lte(nagiPosts.recordCreatedAt, end),
        ),
      ),
    db
      .select({
        targetDid: quoteTarget.did,
        eventAt: nagiPosts.recordCreatedAt,
      })
      .from(nagiPosts)
      .innerJoin(quoteTarget, eq(quoteTarget.uri, nagiPosts.quoteUri))
      .where(
        and(
          eq(nagiPosts.did, actorDid),
          ne(quoteTarget.did, actorDid),
          gte(nagiPosts.recordCreatedAt, start),
          lte(nagiPosts.recordCreatedAt, end),
        ),
      ),
  ]);
  return [...reactionRows, ...replyRows, ...quoteRows];
}

async function loadActorViews(dids: string[]): Promise<Map<string, ActorView>> {
  const unique = [...new Set(dids)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ actor: nagiActors, profile: nagiProfiles })
    .from(nagiActors)
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiActors.did))
    .where(inArray(nagiActors.did, unique));
  return new Map(
    rows.map(({ actor, profile }) => [
      actor.did,
      {
        did: actor.did,
        handle: actor.handle,
        displayName: profile?.displayName ?? undefined,
        avatar: profile?.avatarCid
          ? `/api/blob/${encodeURIComponent(actor.did)}/${profile.avatarCid}`
          : undefined,
        isBot: actor.did === config.botDid,
      },
    ]),
  );
}

/**
 * 日記は本人だけのもの。本人以外（未認証を含む）には undefined を返す。
 * viewerDid を必須引数にしてあるのは、新しい呼び出し元がうっかり渡し忘れたときに
 * 他人の日記が漏れないようにするため。
 */
export function diaryView(
  row: DiaryRow,
  viewerDid: string | undefined,
  involvedActors?: ActorView[],
  involvedActorsHasMore = false,
): DiaryView | undefined {
  if (row.subjectDid !== viewerDid) return undefined;
  return {
    uri: row.uri,
    cid: row.cid,
    subject: row.subjectDid,
    date: row.diaryDate,
    text: row.text,
    titleJa: row.titleJa ?? undefined,
    titleEn: row.titleEn ?? undefined,
    postCount: row.postCount ?? undefined,
    involvedActors: involvedActors?.length ? involvedActors : undefined,
    involvedActorsHasMore: involvedActorsHasMore || undefined,
    langs: (row.langs as string[] | null) ?? undefined,
    createdAt: row.recordCreatedAt.toISOString(),
    indexedAt: row.indexedAt.toISOString(),
  };
}

/** 通知の hydrate 用。 */
export async function fetchDiaryRows(uris: string[]): Promise<DiaryRow[]> {
  if (!uris.length) return [];
  return db.select().from(nagiDiaries).where(inArray(nagiDiaries.uri, uris));
}

/**
 * 日記ページ用。本人の日記だけを返す。
 * from/to を指定すると年間グラフ用の範囲と関わった人を返す。
 * month（"YYYY-MM"）は旧クライアント互換として、その月の全件を日付昇順で返す。
 * 未指定なら新しい順にページングする。
 */
export async function getDiaries(opts: {
  actor: string;
  month?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
  /** 認証必須のエンドポイントなので常にある。actor と一致しなければ拒否する。 */
  viewerDid: string;
}): Promise<{ items: DiaryView[]; cursor?: string; hasMore: boolean }> {
  if (!opts.actor)
    throw new ApiError(400, "invalid_request", "actor is required");
  if (opts.actor !== opts.viewerDid)
    throw new ApiError(
      403,
      "forbidden",
      "Diaries are only available to their owner",
    );
  if (opts.month && !/^\d{4}-\d{2}$/.test(opts.month))
    throw new ApiError(400, "invalid_request", "Invalid month");
  if (opts.month && (opts.from || opts.to))
    throw new ApiError(
      400,
      "invalid_request",
      "month cannot be combined with a date range",
    );
  if (Boolean(opts.from) !== Boolean(opts.to))
    throw new ApiError(
      400,
      "invalid_request",
      "from and to must be provided together",
    );

  if (opts.from && opts.to) {
    validateDiaryRange(opts.from, opts.to);
    const rows = await db
      .select()
      .from(nagiDiaries)
      .where(
        and(
          eq(nagiDiaries.subjectDid, opts.actor),
          gte(nagiDiaries.diaryDate, opts.from),
          lte(nagiDiaries.diaryDate, opts.to),
        ),
      )
      .orderBy(asc(nagiDiaries.diaryDate));
    if (!rows.length) return { items: [], hasMore: false };

    const windows = rows.map((row) => diaryInteractionWindow(row));
    const start = new Date(
      Math.min(...windows.map((window) => window.start.getTime())),
    );
    const end = new Date(
      Math.max(...windows.map((window) => window.end.getTime())),
    );
    const events = await loadDiaryInteractions(opts.actor, start, end);
    const ranked = windows.map((window) =>
      rankDiaryInteractionActors(
        events,
        window,
        opts.actor,
        INVOLVED_ACTOR_LIMIT + 1,
      ),
    );
    const visibleRanked = ranked.map((dids) =>
      dids.slice(0, INVOLVED_ACTOR_LIMIT),
    );
    const actors = await loadActorViews(visibleRanked.flat());
    return {
      items: rows.flatMap(
        (row, index) =>
          diaryView(
            row,
            opts.viewerDid,
            visibleRanked[index].map(
              (did) =>
                actors.get(did) ?? ({ did, handle: did } satisfies ActorView),
            ),
            ranked[index].length > INVOLVED_ACTOR_LIMIT,
          ) ?? [],
      ),
      hasMore: false,
    };
  }

  if (opts.month) {
    const rows = await db
      .select()
      .from(nagiDiaries)
      .where(
        and(
          eq(nagiDiaries.subjectDid, opts.actor),
          like(nagiDiaries.diaryDate, `${opts.month}-%`),
        ),
      )
      .orderBy(asc(nagiDiaries.diaryDate));
    return {
      items: rows.flatMap((row) => diaryView(row, opts.viewerDid) ?? []),
      hasMore: false,
    };
  }

  const filters = [eq(nagiDiaries.subjectDid, opts.actor)];
  // カーソルは日付そのもの。(subject, date) が一意なのでこれで十分。
  if (opts.cursor) filters.push(lt(nagiDiaries.diaryDate, opts.cursor));
  const rows = await db
    .select()
    .from(nagiDiaries)
    .where(and(...filters))
    .orderBy(desc(nagiDiaries.diaryDate))
    .limit(opts.limit);
  const items = rows.flatMap((row) => diaryView(row, opts.viewerDid) ?? []);
  return {
    items,
    cursor:
      items.length === opts.limit ? items[items.length - 1].date : undefined,
    hasMore: items.length === opts.limit,
  };
}
