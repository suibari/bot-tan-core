import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import {
  db,
  MemoryService,
  nagiNews,
  nagiNewsApprovals,
} from "@bsky-affirmative-bot/database";
import { getWhatDayForCalendarDate } from "@bsky-affirmative-bot/shared-configs";
import type {
  UserDiaryContextCandidate,
  UserDiaryContextKind,
  UserDiaryDayContext,
} from "@bsky-affirmative-bot/bot-brain";

const MAX_ACTIVITIES = 8;
const MAX_OBSERVANCES = 8;
const MAX_NEWS = 5;
const CONTEXT_KINDS: UserDiaryContextKind[] = [
  "bot_activity",
  "observance",
  "news",
];

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededSample(values: string[], limit: number, seedText: string): string[] {
  const result = [...values];
  let state = hashSeed(seedText) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result.slice(0, limit);
}

export function preferredDiaryContextKind(
  did: string,
  date: string,
): UserDiaryContextKind {
  const dayNumber = Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 86_400_000);
  return CONTEXT_KINDS[(hashSeed(did) + dayNumber) % CONTEXT_KINDS.length];
}

export function compactDiaryActivities<
  T extends { mood: string; mood_en?: string | null; created_at: Date | string },
>(rows: T[], until: Date): T[] {
  const within = rows.filter(
    (row) => new Date(row.created_at).getTime() < until.getTime(),
  );
  const compact = within.filter(
    (row, index) =>
      index === 0 ||
      row.mood !== within[index - 1]?.mood ||
      row.mood_en !== within[index - 1]?.mood_en,
  );
  return compact.slice(-MAX_ACTIVITIES);
}

export function selectDiaryObservances(
  values: string[],
  did: string,
  date: string,
): string[] {
  return seededSample([...new Set(values)], MAX_OBSERVANCES, `${did}:${date}`);
}

export function getDiaryObservances(date: string): string[] {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const [, year, month, day] = match;
  return getWhatDayForCalendarDate(year, month, day);
}

export type BuildUserDiaryContextInput = {
  did: string;
  date: string;
  since: Date;
  until: Date;
  timezone: string;
  japanese: boolean;
  logger?: Pick<Console, "warn">;
  sources?: {
    getActivities: () => Promise<
      { mood: string; mood_en?: string | null; created_at: Date | string }[]
    >;
    getNews: () => Promise<
      {
        titleJa: string;
        titleEn?: string | null;
        botCommentJa?: string | null;
        botCommentEn?: string | null;
        createdAt: Date;
      }[]
    >;
    getObservances: () => string[];
  };
};

/** 公開日記へ安全に渡せる、個人識別情報を含まない一日分の補助材料を作る。 */
export async function buildUserDiaryContext(
  input: BuildUserDiaryContextInput,
): Promise<UserDiaryDayContext> {
  const logger = input.logger ?? console;
  const sources = input.sources ?? {
    getActivities: () => MemoryService.getBiorhythmHistorySince(input.since),
    getNews: () =>
      db
        .select({
          titleJa: nagiNews.titleJa,
          titleEn: nagiNewsApprovals.titleEn,
          botCommentJa: nagiNewsApprovals.botCommentJa,
          botCommentEn: nagiNewsApprovals.botCommentEn,
          createdAt: nagiNews.recordCreatedAt,
        })
        .from(nagiNews)
        .innerJoin(
          nagiNewsApprovals,
          and(
            eq(nagiNewsApprovals.newsUri, nagiNews.uri),
            eq(nagiNewsApprovals.newsCid, nagiNews.cid),
          ),
        )
        .where(
          and(
            eq(nagiNewsApprovals.status, "approved"),
            isNull(nagiNewsApprovals.hiddenAt),
            isNull(nagiNews.deletedAt),
            gte(nagiNews.recordCreatedAt, input.since),
            lt(nagiNews.recordCreatedAt, input.until),
          ),
        )
        .orderBy(asc(nagiNews.recordCreatedAt))
        .limit(MAX_NEWS),
    getObservances: () => getDiaryObservances(input.date),
  };
  const [activityRows, newsRows] = await Promise.all([
    sources.getActivities().catch((error) => {
      logger.warn("[WARN][DIARY] Failed to load biorhythm context:", error);
      return [];
    }),
    sources.getNews().catch((error) => {
        logger.warn("[WARN][DIARY] Failed to load news context:", error);
        return [];
      }),
  ]);

  const time = new Intl.DateTimeFormat(input.japanese ? "ja-JP" : "en-US", {
    timeZone: input.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const candidates: UserDiaryContextCandidate[] = [];

  for (const [index, row] of compactDiaryActivities(activityRows, input.until).entries()) {
    candidates.push({
      id: `bot_activity:${index + 1}`,
      kind: "bot_activity",
      textJa: `${time.format(new Date(row.created_at))} ${row.mood}`,
      textEn: `${time.format(new Date(row.created_at))} ${row.mood_en || row.mood}`,
    });
  }

  let observanceValues: string[] = [];
  try {
    observanceValues = sources.getObservances();
  } catch (error) {
    logger.warn("[WARN][DIARY] Failed to load observance context:", error);
  }
  const observances = selectDiaryObservances(observanceValues, input.did, input.date);
  for (const [index, value] of observances.entries()) {
    candidates.push({
      id: `observance:${index + 1}`,
      kind: "observance",
      textJa: value,
      textEn: value,
    });
  }

  for (const [index, row] of newsRows.slice(0, MAX_NEWS).entries()) {
    candidates.push({
      id: `news:${index + 1}`,
      kind: "news",
      textJa: `${row.titleJa}${row.botCommentJa ? `（${row.botCommentJa}）` : ""}`,
      textEn: `${row.titleEn || row.titleJa}${row.botCommentEn ? ` (${row.botCommentEn})` : ""}`,
    });
  }

  return {
    date: input.date,
    preferredKind: preferredDiaryContextKind(input.did, input.date),
    candidates,
  };
}
