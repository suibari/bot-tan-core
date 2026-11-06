import {
  db,
  loadDiaryDayHistory,
  nagiActors,
  nagiDiaries,
  nagiPostMoods,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import type {
  ActorView,
  DiaryMoodView,
  DiaryView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  diaryDateOf,
  diaryDayWindow,
  POST_MOOD_VERSION,
  type DiaryDayHistory,
} from "@bsky-affirmative-bot/shared-configs";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError } from "../middleware/errors.js";
import { config } from "../config.js";
import { getZenkatsuChiefDids } from "./zenkatsu.js";

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
  const [rows, chiefs] = await Promise.all([
    db.select({ actor: nagiActors, profile: nagiProfiles })
      .from(nagiActors)
      .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiActors.did))
      .where(inArray(nagiActors.did, unique)),
    getZenkatsuChiefDids(unique),
  ]);
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
        ...(chiefs.has(actor.did) ? { zenkatsuChief: true } : {}),
      },
    ]),
  );
}

/** 感情グラフの一覧に載せる本文の上限。点の説明に使うだけなので、全文は要らない。 */
const MOOD_TEXT_MAX = 200;

/**
 * 期間内の、気分が読み取れた投稿の点。中立（告知・事実共有など）と採点不能は載せない。
 * pending は期間内でまだ採点されていない投稿数（導入直後のバックフィル中の表示に使う）。
 *
 * 本人が直した点（user_valence）は LLM の値より優先し、版上げの採点し直し待ちでも出す。
 * 本人の判断は採点基準の版に左右されないので、古い版のままでも消さない。
 */
export async function loadDiaryMoods(
  actor: string,
  from: string,
  to: string,
  history: DiaryDayHistory,
): Promise<{
  moods: DiaryMoodView[];
  moodPending: number;
  moodTimezone: string;
  moodDayStartHour: number;
  moodDayWindows: DiaryDayWindowView[];
}> {
  // 日記の日付は shared-configs の diaryDateOf だけで決める（日記の生成と同じ決め方）。
  const start = diaryDayWindow(from, history).start;
  const end = diaryDayWindow(to, history).end;
  const rows = await db
    .select({
      uri: nagiPosts.uri,
      text: nagiPosts.text,
      createdAt: nagiPosts.recordCreatedAt,
      selfLabels: nagiPosts.selfLabels,
      moderationLabels: nagiPosts.moderationLabels,
      scored: nagiPostMoods.postUri,
      version: nagiPostMoods.version,
      valence: nagiPostMoods.valence,
      expressive: nagiPostMoods.expressive,
      userValence: nagiPostMoods.userValence,
    })
    .from(nagiPosts)
    .leftJoin(
      nagiPostMoods,
      and(
        eq(nagiPostMoods.postUri, nagiPosts.uri),
        // 編集後の採点し直し待ちは、古い点を出さずに未採点として数える。
        eq(nagiPostMoods.cid, nagiPosts.cid),
      ),
    )
    .where(
      and(
        eq(nagiPosts.did, actor),
        isNull(nagiPosts.deletedAt),
        gt(nagiPosts.recordCreatedAt, start),
        lte(nagiPosts.recordCreatedAt, end),
        or(
          isNull(nagiPostMoods.postUri),
          isNotNull(nagiPostMoods.userValence),
          ne(nagiPostMoods.version, POST_MOOD_VERSION),
          and(
            isNotNull(nagiPostMoods.valence),
            eq(nagiPostMoods.expressive, true),
          ),
        ),
      ),
    )
    .orderBy(asc(nagiPosts.recordCreatedAt));

  const moods: DiaryMoodView[] = [];
  let moodPending = 0;
  for (const row of rows) {
    const date = diaryDateOf(row.createdAt, history);
    if (date < from || date > to) continue;
    const point = moodPoint(row);
    if (point === "pending") {
      if (row.text.trim()) moodPending += 1;
      continue;
    }
    if (!point) continue;
    moods.push({
      uri: row.uri,
      date,
      createdAt: row.createdAt.toISOString(),
      valence: point.valence,
      ...(point.edited ? { edited: true } : {}),
      text: row.text.slice(0, MOOD_TEXT_MAX),
      // 抜粋もタイムラインと同じ表示設定（非表示・警告）で隠せるよう、ラベルを添える。
      selfLabels: row.selfLabels.length ? row.selfLabels : undefined,
      moderationLabels: row.moderationLabels.length
        ? row.moderationLabels
        : undefined,
    });
  }
  // 点のある日ごとの窓も返す。クライアントが1日の中の位置（区切り〜区切りの横バー）を
  // 同じ区切りで描けるようにするため。期間の途中で設定が変わることがあるので日ごとに持つ。
  const dates = [...new Set(moods.map((mood) => mood.date))];
  const moodDayWindows = dates.map((date) => {
    const window = diaryDayWindow(date, history);
    return {
      date,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      timezone: window.timezone,
      startHour: window.startHour,
    };
  });
  // 旧クライアントは moodTimezone（と22時固定）で描く。期間の最後の日の設定を渡す。
  const latest = diaryDayWindow(to, history);
  return {
    moods,
    moodPending,
    moodTimezone: latest.timezone,
    moodDayStartHour: latest.startHour,
    moodDayWindows,
  };
}

/** 感情グラフの1日の窓。start は含まず、end を含む。 */
export type DiaryDayWindowView = {
  date: string;
  start: string;
  end: string;
  timezone: string;
  startHour: number;
};

/**
 * 1投稿の採点から、グラフに出す値を決める。本人の修正があればそれ、無ければ
 * 現行版の LLM の値（気分が読み取れたものだけ）。採点が無い・版が古いものは "pending"。
 */
export function moodPoint(row: {
  scored: string | null;
  version: string | null;
  valence: number | null;
  expressive: boolean | null;
  userValence: number | null;
}): { valence: number; edited: boolean } | "pending" | undefined {
  if (row.scored === null) return "pending";
  if (row.userValence !== null) return { valence: row.userValence, edited: true };
  if (row.version !== POST_MOOD_VERSION) return "pending";
  if (row.valence === null || !row.expressive || row.valence === 0) return undefined;
  return { valence: row.valence, edited: false };
}

/**
 * 感情グラフの点を本人が直す。valence を省くと LLM の値に戻す。
 *
 * 直せるのは自分の投稿で、いまグラフに出ている点（現行の採点がある、または直したことがある）
 * だけ。中立と判定された投稿はグラフに出ていないので対象外。返り値の mood が無ければ、
 * 戻した結果グラフから外れた（または採点し直し待ち）ということ。
 */
export async function setPostMood(
  viewerDid: string,
  input: { uri?: unknown; valence?: unknown },
): Promise<{ mood?: DiaryMoodView }> {
  const uri = typeof input.uri === "string" ? input.uri : "";
  if (!uri) throw new ApiError(400, "invalid_request", "uri is required");
  const valence = input.valence ?? null;
  if (
    valence !== null &&
    (typeof valence !== "number" ||
      !Number.isInteger(valence) ||
      valence < -5 ||
      valence > 5 ||
      valence === 0)
  )
    throw new ApiError(400, "invalid_request", "valence must be an integer in -5..-1 or 1..5");

  const [row] = await db
    .select({
      uri: nagiPosts.uri,
      text: nagiPosts.text,
      createdAt: nagiPosts.recordCreatedAt,
      selfLabels: nagiPosts.selfLabels,
      moderationLabels: nagiPosts.moderationLabels,
      scored: nagiPostMoods.postUri,
      version: nagiPostMoods.version,
      valence: nagiPostMoods.valence,
      expressive: nagiPostMoods.expressive,
      userValence: nagiPostMoods.userValence,
    })
    .from(nagiPosts)
    .innerJoin(
      nagiPostMoods,
      and(eq(nagiPostMoods.postUri, nagiPosts.uri), eq(nagiPostMoods.cid, nagiPosts.cid)),
    )
    .where(
      and(
        eq(nagiPosts.uri, uri),
        eq(nagiPosts.did, viewerDid),
        isNull(nagiPosts.deletedAt),
      ),
    );
  // 他人の投稿も、採点の無い投稿も、同じ 404 にする（他人の投稿の採点有無を漏らさない）。
  const current = row ? moodPoint(row) : undefined;
  if (!row || !current || current === "pending")
    throw new ApiError(404, "not_found", "Mood point not found");

  await db
    .update(nagiPostMoods)
    .set({ userValence: valence, userEditedAt: valence === null ? null : new Date() })
    .where(eq(nagiPostMoods.postUri, uri));

  const next = moodPoint({ ...row, userValence: valence });
  if (!next || next === "pending") return {};
  const history = await loadDiaryDayHistory(viewerDid);
  return {
    mood: {
      uri: row.uri,
      date: diaryDateOf(row.createdAt, history),
      createdAt: row.createdAt.toISOString(),
      valence: next.valence,
      ...(next.edited ? { edited: true } : {}),
      text: row.text.slice(0, MOOD_TEXT_MAX),
      selfLabels: row.selfLabels.length ? row.selfLabels : undefined,
      moderationLabels: row.moderationLabels.length ? row.moderationLabels : undefined,
    },
  };
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

/** 年間グラフ用。期間内の日記と、それぞれの日に関わった相手。 */
async function getDiaryRange(
  actor: string,
  from: string,
  to: string,
  viewerDid: string,
  history: DiaryDayHistory,
): Promise<{ items: DiaryView[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(nagiDiaries)
    .where(
      and(
        eq(nagiDiaries.subjectDid, actor),
        gte(nagiDiaries.diaryDate, from),
        lte(nagiDiaries.diaryDate, to),
      ),
    )
    .orderBy(asc(nagiDiaries.diaryDate));
  if (!rows.length) return { items: [], hasMore: false };

  const windows = rows.map((row) => diaryDayWindow(row.diaryDate, history));
  const start = new Date(
    Math.min(...windows.map((window) => window.start.getTime())),
  );
  const end = new Date(
    Math.max(...windows.map((window) => window.end.getTime())),
  );
  const events = await loadDiaryInteractions(actor, start, end);
  const ranked = windows.map((window) =>
    rankDiaryInteractionActors(
      events,
      window,
      actor,
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
          viewerDid,
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
  /** 感情グラフ用の点も返す。from/to と組み合わせたときだけ有効。 */
  moods?: boolean;
  /** 認証必須のエンドポイントなので常にある。actor と一致しなければ拒否する。 */
  viewerDid: string;
}): Promise<{
  items: DiaryView[];
  cursor?: string;
  hasMore: boolean;
  moods?: DiaryMoodView[];
  moodPending?: number;
  /** moods の date を切ったタイムゾーン（IANA 名）。期間の最後の日の値。moods を要求したときだけ。 */
  moodTimezone?: string;
  /** 区切りの時刻。期間の最後の日の値。moods を要求したときだけ。 */
  moodDayStartHour?: number;
  /** 点のある日ごとの窓。moods を要求したときだけ。 */
  moodDayWindows?: DiaryDayWindowView[];
}> {
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
    const history = await loadDiaryDayHistory(opts.actor);
    const [page, moods] = await Promise.all([
      getDiaryRange(opts.actor, opts.from, opts.to, opts.viewerDid, history),
      opts.moods ? loadDiaryMoods(opts.actor, opts.from, opts.to, history) : undefined,
    ]);
    return { ...page, ...moods };
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
