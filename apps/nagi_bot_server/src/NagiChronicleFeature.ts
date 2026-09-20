import {
  db,
  nagiChronicleEvents,
  nagiChronicleJobs,
  nagiChronicleNews,
  nagiDiaries,
  nagiNews,
  nagiNewsApprovals,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import {
  CHRONICLE_NEWS_CANDIDATE_LIMIT,
  generateChronicleMonth,
  generateChronicleNews,
  NAGI_CHRONICLE_NEWS_PROMPT_VERSION,
  NAGI_CHRONICLE_PROMPT_VERSION,
  type ChronicleMonthInput,
  type ChronicleNewsCandidate,
} from "@bsky-affirmative-bot/bot-brain";
import { cardDrawDate } from "@bsky-affirmative-bot/shared-configs";
import { and, asc, desc, eq, gte, isNull, lt, notInArray, sql } from "drizzle-orm";

/**
 * 自分年表の月次ロールアップ。
 *
 * その月の日記をまとめて読み、「大きな出来事」と「そのころ世の中では」を
 * nagi.chronicle_events へ書く。**書き込みは月ごと丸ごと置換**なので、何度走らせても
 * 増えないし、あとから日記が増えたら作り直せる。
 */

const MONTH = /^\d{4}-\d{2}$/;

/** 月の最終日。"YYYY-MM" → "YYYY-MM-DD"。 */
function monthEnd(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/** その月の翌月初日。範囲比較の上限に使う（text の辞書順で正しく効く）。 */
function nextMonthStart(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return mon === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
}

/**
 * その月のニュース候補。**利用者では絞らない。**
 *
 * これは「その月に世の中で何があったか」の欄なので、誰の関心に当たるかは関係ない。
 * ただし1か月で最大620件（1日20件×31日）あり、全部は載せられないし、12B のモデルに
 * 600件から番号で1件選ばせるのも当てにならない。**反応の多い順**で絞ってから渡す
 * （誰かが気に留めた記事、という弱いながら実在の信号）。
 */
async function loadMonthNewsCandidates(
  month: string,
): Promise<{ uris: string[]; candidates: ChronicleNewsCandidate[] }> {
  const from = new Date(`${month}-01T00:00:00.000Z`);
  const until = new Date(`${nextMonthStart(month)}T00:00:00.000Z`);
  const reactions = db.$with("reactions").as(
    db
      .select({
        uri: nagiReactions.subjectUri,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(nagiReactions)
      .groupBy(nagiReactions.subjectUri),
  );
  const rows = await db
    .with(reactions)
    .select({
      uri: nagiNews.uri,
      title: nagiNewsApprovals.snapshotTitleJa,
      fallbackTitle: nagiNews.titleJa,
      at: nagiNews.indexedAt,
      reactionCount: sql<number>`coalesce(${reactions.count}, 0)`,
    })
    .from(nagiNews)
    .innerJoin(
      nagiNewsApprovals,
      and(
        eq(nagiNewsApprovals.newsUri, nagiNews.uri),
        eq(nagiNewsApprovals.newsCid, nagiNews.cid),
      ),
    )
    .leftJoin(reactions, eq(reactions.uri, nagiNews.uri))
    .where(
      and(
        isNull(nagiNews.deletedAt),
        isNull(nagiNewsApprovals.hiddenAt),
        eq(nagiNewsApprovals.status, "approved"),
        gte(nagiNews.indexedAt, from),
        lt(nagiNews.indexedAt, until),
      ),
    )
    .orderBy(desc(sql`coalesce(${reactions.count}, 0)`), desc(nagiNews.indexedAt))
    .limit(CHRONICLE_NEWS_CANDIDATE_LIMIT);
  return {
    uris: rows.map((row) => row.uri),
    candidates: rows.map((row) => ({
      title: row.title ?? row.fallbackTitle,
      date: cardDrawDate(row.at),
    })),
  };
}

/**
 * その月の「そのころ世の中では」を確定する。**全ユーザー共通で、月に1回だけ。**
 * 日記のロールアップとは独立していて、日記が1件も無い月でも走る。
 */
export async function processChronicleNews(month: string): Promise<{
  picked: boolean;
  candidateCount: number;
}> {
  if (!MONTH.test(month)) throw new Error(`chronicle: invalid month "${month}"`);
  const { uris, candidates } = await loadMonthNewsCandidates(month);
  const result = candidates.length
    ? await generateChronicleNews({ month, candidates })
    : {};
  const picked = result.index !== undefined && Boolean(uris[result.index]);
  await db
    .insert(nagiChronicleNews)
    .values({
      month,
      newsUri: picked ? uris[result.index!] : null,
      titleJa: picked ? result.titleJa! : null,
      titleEn: picked ? result.titleEn! : null,
      candidateCount: candidates.length,
      state: "posted",
      leaseExpiresAt: null,
      lastError: null,
      promptVersion: NAGI_CHRONICLE_NEWS_PROMPT_VERSION,
    })
    .onConflictDoUpdate({
      target: nagiChronicleNews.month,
      set: {
        newsUri: sql`excluded.news_uri`,
        titleJa: sql`excluded.title_ja`,
        titleEn: sql`excluded.title_en`,
        candidateCount: sql`excluded.candidate_count`,
        state: sql`excluded.state`,
        leaseExpiresAt: null,
        lastError: null,
        promptVersion: sql`excluded.prompt_version`,
        updatedAt: new Date(),
      },
    });
  console.log(
    `[INFO][NAGI][CHRONICLE][NEWS] ${month}: ${picked ? `picked "${result.titleJa}"` : "no pick"} from ${candidates.length} candidate(s)`,
  );
  return { picked, candidateCount: candidates.length };
}

export interface ChronicleMonthRun {
  /** 書いた行数。0 は「この月に節目は無かった」で、正常。 */
  written: number;
  /** 材料にした日記の件数。ジョブの自己修復判定に使う。 */
  diaryCount: number;
}

/**
 * 1人ぶん・1か月ぶんを確定する。
 *
 * 呼び出し口は3つ: 月次ワーカー / `POST /chronicle/run` / バックフィル。
 * どこから呼んでも同じ結果になるよう、月ごと丸ごと置換で書く。
 */
export async function processChronicleMonth(
  did: string,
  month: string,
): Promise<ChronicleMonthRun> {
  if (!MONTH.test(month)) throw new Error(`chronicle: invalid month "${month}"`);

  const diaries = await db
    .select({
      date: nagiDiaries.diaryDate,
      text: nagiDiaries.text,
      uri: nagiDiaries.uri,
      titleJa: nagiDiaries.titleJa,
      langs: nagiDiaries.langs,
    })
    .from(nagiDiaries)
    .where(
      and(
        eq(nagiDiaries.subjectDid, did),
        gte(nagiDiaries.diaryDate, `${month}-01`),
        lt(nagiDiaries.diaryDate, nextMonthStart(month)),
      ),
    )
    .orderBy(asc(nagiDiaries.diaryDate));

  if (!diaries.length) {
    console.log(`[INFO][NAGI][CHRONICLE][${did}] no diaries in ${month}`);
    await replaceMonth(did, month, []);
    return { written: 0, diaryCount: 0 };
  }

  const profile = await db
    .select({ displayName: nagiProfiles.displayName })
    .from(nagiProfiles)
    .where(eq(nagiProfiles.did, did))
    .limit(1);

  // 日記と同じ言語判定。その月の最後に言語が付いていた日記に合わせる。
  const langs = [...diaries]
    .reverse()
    .find((row) => Array.isArray(row.langs) && row.langs.length)?.langs as
    | string[]
    | undefined;
  const japanese = !langs?.length || langs[0].startsWith("ja");

  const input: ChronicleMonthInput = {
    displayName: profile[0]?.displayName || "あなた",
    month,
    japanese,
    diaries: diaries.map((row) => ({
      date: row.date,
      ...(row.titleJa ? { titleJa: row.titleJa } : {}),
      text: row.text,
    })),
  };

  const result = await generateChronicleMonth(input);
  const uriByDate = new Map(diaries.map((row) => [row.date, row.uri]));

  const rows: ChronicleRow[] = result.highlights.map((highlight, index) => ({
    subjectDid: did,
    eventDate: highlight.date,
    kind: "highlight",
    sourceMonth: month,
    dedupeKey: `llm:${month}:${index}`,
    titleJa: highlight.titleJa,
    titleEn: highlight.titleEn,
    detailJa: highlight.detailJa,
    detailEn: highlight.detailEn,
    evidence: highlight.evidence,
    diaryUri: uriByDate.get(highlight.date) ?? null,
    newsUri: null,
    promptVersion: NAGI_CHRONICLE_PROMPT_VERSION,
  }));


  await replaceMonth(did, month, rows);
  console.log(
    `[INFO][NAGI][CHRONICLE][${did}] ${month}: wrote ${rows.length} event(s) from ${diaries.length} diaries`,
  );
  return { written: rows.length, diaryCount: diaries.length };
}

type ChronicleRow = typeof nagiChronicleEvents.$inferInsert;

/**
 * その月ぶんを丸ごと置き換える。
 *
 * **UNIQUE(subject_did, dedupe_key) の upsert だけでは足りない。** 前回3件・今回1件のとき、
 * 前回の2件目以降が残ってしまう。同じ月で今回の鍵に無い行を必ず消す。
 */
async function replaceMonth(
  did: string,
  month: string,
  rows: ChronicleRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    if (rows.length) {
      await tx
        .insert(nagiChronicleEvents)
        .values(rows)
        .onConflictDoUpdate({
          target: [nagiChronicleEvents.subjectDid, nagiChronicleEvents.dedupeKey],
          set: {
            eventDate: sql`excluded.event_date`,
            kind: sql`excluded.kind`,
            sourceMonth: sql`excluded.source_month`,
            titleJa: sql`excluded.title_ja`,
            titleEn: sql`excluded.title_en`,
            detailJa: sql`excluded.detail_ja`,
            detailEn: sql`excluded.detail_en`,
            evidence: sql`excluded.evidence`,
            diaryUri: sql`excluded.diary_uri`,
            newsUri: sql`excluded.news_uri`,
            promptVersion: sql`excluded.prompt_version`,
            updatedAt: new Date(),
          },
        });
    }
    const keys = rows.map((row) => row.dedupeKey);
    await tx
      .delete(nagiChronicleEvents)
      .where(
        and(
          eq(nagiChronicleEvents.subjectDid, did),
          eq(nagiChronicleEvents.sourceMonth, month),
          ...(keys.length
            ? [notInArray(nagiChronicleEvents.dedupeKey, keys)]
            : []),
        ),
      );
  });
}

/**
 * まだジョブの無い「閉じた月」を積む。
 *
 * ついでに、エンキュー時点より日記が増えた月を pending へ戻す。遅れて入った日記の回収を、
 * タイムゾーンの厳密計算ではなく「作り直しても安全」という性質で担保している。
 */
export async function sweepChronicleJobs(
  currentMonth: string,
  limit = 200,
): Promise<number> {
  const months = await db
    .select({
      subjectDid: nagiDiaries.subjectDid,
      month: sql<string>`substr(${nagiDiaries.diaryDate}, 1, 7)`,
      diaryCount: sql<number>`count(*)::int`,
    })
    .from(nagiDiaries)
    .where(lt(sql`substr(${nagiDiaries.diaryDate}, 1, 7)`, currentMonth))
    .groupBy(nagiDiaries.subjectDid, sql`substr(${nagiDiaries.diaryDate}, 1, 7)`)
    .limit(limit);
  if (!months.length) return 0;

  const inserted = await db
    .insert(nagiChronicleJobs)
    .values(months)
    .onConflictDoNothing()
    .returning({ subjectDid: nagiChronicleJobs.subjectDid });

  // 日記が増えていた月は作り直す（すでに posted でも戻す）。
  const stale = months.filter((row) => row.diaryCount > 0);
  for (const row of stale) {
    await db
      .update(nagiChronicleJobs)
      .set({
        state: "pending",
        diaryCount: row.diaryCount,
        attempts: 0,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nagiChronicleJobs.subjectDid, row.subjectDid),
          eq(nagiChronicleJobs.month, row.month),
          sql`${nagiChronicleJobs.diaryCount} <> ${row.diaryCount}`,
        ),
      );
  }
  return inserted.length;
}

/**
 * まだ扱っていない「閉じた月」を chronicle_news へ積む。
 *
 * 日記の有無とは無関係に、**ニュースがあった月は全部**対象になる
 * （年表の背景なので、その月に誰も日記を書いていなくても出してよい）。
 */
export async function sweepChronicleNews(currentMonth: string): Promise<number> {
  const months = await db
    .selectDistinct({
      month: sql<string>`to_char(${nagiNews.indexedAt}, 'YYYY-MM')`,
    })
    .from(nagiNews)
    .where(
      and(
        isNull(nagiNews.deletedAt),
        lt(sql`to_char(${nagiNews.indexedAt}, 'YYYY-MM')`, currentMonth),
      ),
    );
  if (!months.length) return 0;
  const inserted = await db
    .insert(nagiChronicleNews)
    .values(months.map((row) => ({ month: row.month })))
    .onConflictDoNothing()
    .returning({ month: nagiChronicleNews.month });
  return inserted.length;
}

/** バックフィル用。対象月をジョブ表へ積むだけで、生成はワーカーに任せる。 */
export async function enqueueChronicleMonths(
  rows: { subjectDid: string; month: string; diaryCount: number }[],
): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await db
    .insert(nagiChronicleJobs)
    .values(rows)
    .onConflictDoNothing()
    .returning({ subjectDid: nagiChronicleJobs.subjectDid });
  return inserted.length;
}

/** アカウント削除との整合用。AppView 側の deleteAccountData も同じ2テーブルを消す。 */
export async function purgeChronicle(did: string): Promise<void> {
  await db
    .delete(nagiChronicleEvents)
    .where(eq(nagiChronicleEvents.subjectDid, did));
  await db.delete(nagiChronicleJobs).where(eq(nagiChronicleJobs.subjectDid, did));
}

export { monthEnd, nextMonthStart };
