import {
  db,
  nagiActors,
  nagiCommunityAffirmations,
  nagiPosts,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import {
  COMMUNITY_AFFIRMATION_PROMPT_VERSION,
  generateCommunityAffirmation,
  type CommunityAffirmationInput,
} from "@bsky-affirmative-bot/bot-brain";
import {
  blobImagesToImageRefs,
  resolvePdsUrl,
} from "@bsky-affirmative-bot/bot-runtime";
import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

const ONE_HOUR_MS = 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 300_000;
const WORKER_INTERVAL_MS = 10_000;
const CANDIDATE_REFRESH_MS = 60_000;
/**
 * 1作者がストックを占有しないための上限。この本数までなら、同じ人の投稿が
 * 直近 AUTHOR_STOCK_WINDOW_MS の間に複数ストックされてよい。
 * 旧実装は「1作者1行 + 24hクールダウン」だったため、一覧がほとんど動かなかった。
 */
const AUTHOR_STOCK_LIMIT = 3;
const AUTHOR_STOCK_WINDOW_MS = 24 * ONE_HOUR_MS;
/**
 * 1回の候補リフレッシュで積む上限。供給があるときに一気に食い尽くさず、
 * 時間方向に散らして「毎時なにか新しいものがある」状態を保つ。
 */
const MAX_ENQUEUE_PER_REFRESH = 3;
/** 候補走査の上限。ストック済みは SQL 側で除外しているので、この範囲で足りる。 */
const CANDIDATE_SCAN_LIMIT = 200;
const LOG_PREFIX = "[community-affirmation]";

const logCommunityAffirmation = (
  event: string,
  details: Record<string, unknown> = {},
) => console.info(LOG_PREFIX, { event, ...details });

type Candidate = {
  post: typeof nagiPosts.$inferSelect;
  pdsUrl: string | null;
  reactionCount: number;
};

const textHasContentWarning = (text: string) => {
  let markers = 0;
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") {
      inCode = !inCode;
      continue;
    }
    if (!inCode && text.startsWith("||", index)) {
      markers += 1;
      index += 1;
    }
  }
  return markers === 2;
};

export function hasCommunityAffirmationContentWarning(
  post: Pick<
    typeof nagiPosts.$inferSelect,
    "text" | "recordJson" | "embedImages"
  >,
) {
  const record = post.recordJson as any;
  const images = (post.embedImages ?? record?.embed?.images) as
    Array<{ contentWarning?: boolean }> | undefined;
  return (
    record?.cwRestricted === true ||
    textHasContentWarning(post.text) ||
    Boolean(images?.some((image) => image?.contentWarning === true))
  );
}

/**
 * 候補をストックしてよいか。作者ごとの直近ストック数だけで決める。
 * 1作者1行という構造上の制約は主キーの変更で無くなったので、ここが唯一の占有防止になる。
 */
export function canStockForAuthor(recentCount: number) {
  return recentCount < AUTHOR_STOCK_LIMIT;
}

export function communityAffirmationGenerationWindow(now: Date) {
  return {
    newest: new Date(now.getTime() - ONE_HOUR_MS),
    oldest: new Date(now.getTime() - SEVEN_DAYS_MS),
  };
}

export function isNewCommunityAffirmationCandidateReactionEligible(
  reactionCount: number,
) {
  return reactionCount <= 1;
}

export function communityAffirmationRetry(attempts: number) {
  return {
    failed: attempts >= MAX_ATTEMPTS,
    backoffMs: Math.min(MAX_BACKOFF_MS, 2 ** attempts * 5_000),
  };
}

async function eligibleCandidates(now: Date): Promise<Candidate[]> {
  const generationWindow = communityAffirmationGenerationWindow(now);
  const rows = await db
    .select({
      post: nagiPosts,
      pdsUrl: nagiActors.pdsUrl,
      reactionCount: sql<number>`(
        select count(*)::int
        from nagi.reactions as community_reaction
        where community_reaction.subject_uri = ${nagiPosts.uri}
      )`,
    })
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .where(
      and(
        isNull(nagiPosts.deletedAt),
        isNull(nagiPosts.replyParentUri),
        ne(nagiPosts.did, process.env.NAGI_BOT_DID!),
        lte(nagiPosts.recordCreatedAt, generationWindow.newest),
        gte(nagiPosts.recordCreatedAt, generationWindow.oldest),
        // 「まだ拾われていない投稿を拾う」というこの機能の選定思想。読み出し側では
        // 判定しないので（一覧に出たあとで反応が付いても消えない）、ここが唯一の関門。
        sql`(
          select count(*)
          from nagi.reactions as community_reaction
          where community_reaction.subject_uri = ${nagiPosts.uri}
        ) <= 1`,
        // ストック済みの投稿は二度と候補にしない。走査に上限を付けても
        // 新しい候補まで届くようにするため、SQL 側で落としておく。
        sql`not exists (
          select 1
          from nagi.community_affirmations as stocked
          where stocked.source_uri = ${nagiPosts.uri}
        )`,
      ),
    )
    .orderBy(
      sql`(
        select count(*)
        from nagi.reactions as community_reaction
        where community_reaction.subject_uri = ${nagiPosts.uri}
      )`,
      asc(nagiPosts.recordCreatedAt),
      asc(nagiPosts.uri),
    )
    .limit(CANDIDATE_SCAN_LIMIT);

  return rows
    .map((row) => ({ ...row, reactionCount: Number(row.reactionCount) }))
    .filter(
      ({ post, reactionCount }) =>
        isNewCommunityAffirmationCandidateReactionEligible(reactionCount) &&
        !hasCommunityAffirmationContentWarning(post),
    );
}

/** 直近 AUTHOR_STOCK_WINDOW_MS のあいだに積んだ行数を作者ごとに数える。 */
async function recentStockByAuthor(now: Date, authorDids: string[]) {
  const counts = new Map<string, number>();
  if (!authorDids.length) return counts;
  const rows = await db
    .select({
      authorDid: nagiCommunityAffirmations.authorDid,
      count: sql<number>`count(*)::int`,
    })
    .from(nagiCommunityAffirmations)
    .where(
      and(
        inArray(nagiCommunityAffirmations.authorDid, authorDids),
        gte(
          nagiCommunityAffirmations.createdAt,
          new Date(now.getTime() - AUTHOR_STOCK_WINDOW_MS),
        ),
      ),
    )
    .groupBy(nagiCommunityAffirmations.authorDid);
  for (const row of rows) counts.set(row.authorDid, Number(row.count));
  return counts;
}

/**
 * プロンプトを更新したときだけ、生成済みの行を作り直す。
 * 通常の運用では触らない（一度 rejected になった投稿を蒸し返さない）。
 */
async function requeueStalePromptVersions(now: Date) {
  const generationWindow = communityAffirmationGenerationWindow(now);
  // AppView の表示窓から外れた旧カードは作り直さない。期限切れ行を再キューすると、
  // 新規候補の供給を塞いだうえで insufficient_context へ変えてしまう。
  const stale = await db
    .select({ sourceUri: nagiCommunityAffirmations.sourceUri })
    .from(nagiCommunityAffirmations)
    .innerJoin(
      nagiPosts,
      and(
        eq(nagiPosts.uri, nagiCommunityAffirmations.sourceUri),
        eq(nagiPosts.cid, nagiCommunityAffirmations.sourceCid),
      ),
    )
    .where(
      and(
        or(
          eq(nagiCommunityAffirmations.state, "posted"),
          eq(nagiCommunityAffirmations.state, "rejected"),
        ),
        or(
          isNull(nagiCommunityAffirmations.promptVersion),
          ne(
            nagiCommunityAffirmations.promptVersion,
            COMMUNITY_AFFIRMATION_PROMPT_VERSION,
          ),
        ),
        isNull(nagiPosts.deletedAt),
        isNull(nagiPosts.replyParentUri),
        ne(nagiPosts.did, process.env.NAGI_BOT_DID!),
        lte(nagiPosts.recordCreatedAt, generationWindow.newest),
        gte(nagiPosts.recordCreatedAt, generationWindow.oldest),
      ),
    )
    .limit(MAX_ENQUEUE_PER_REFRESH);
  for (const row of stale) {
    await db
      .update(nagiCommunityAffirmations)
      .set({
        state: "pending",
        attempts: 0,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(nagiCommunityAffirmations.sourceUri, row.sourceUri),
          or(
            eq(nagiCommunityAffirmations.state, "posted"),
            eq(nagiCommunityAffirmations.state, "rejected"),
          ),
          or(
            isNull(nagiCommunityAffirmations.promptVersion),
            ne(
              nagiCommunityAffirmations.promptVersion,
              COMMUNITY_AFFIRMATION_PROMPT_VERSION,
            ),
          ),
        ),
      );
    logCommunityAffirmation("candidate_queued", {
      sourceUri: row.sourceUri,
      reason: "prompt_upgrade",
      promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
    });
  }
  return stale.length;
}

async function refreshCandidates(now: Date) {
  // プロンプト更新の作り直しを先に消化する。同じ回で新規も積むと、更新直後に
  // 生成キューが一気に膨らむため、1回の上限はここと共有する。
  const requeued = await requeueStalePromptVersions(now);
  if (requeued >= MAX_ENQUEUE_PER_REFRESH) return;

  const candidates = await eligibleCandidates(now);
  if (!candidates.length) return;
  const recent = await recentStockByAuthor(now, [
    ...new Set(candidates.map((candidate) => candidate.post.did)),
  ]);

  let enqueued = requeued;
  for (const candidate of candidates) {
    if (enqueued >= MAX_ENQUEUE_PER_REFRESH) break;
    const authorDid = candidate.post.did;
    const stocked = recent.get(authorDid) ?? 0;
    if (!canStockForAuthor(stocked)) continue;

    await db
      .insert(nagiCommunityAffirmations)
      .values({
        authorDid,
        sourceUri: candidate.post.uri,
        sourceCid: candidate.post.cid,
        state: "pending",
        attempts: 0,
        nextAttemptAt: now,
        // 主キーが投稿になったので、この列はリトライ制御のためだけに残っている。
        nextEligibleAt: now,
        createdAt: now,
        updatedAt: now,
      })
      // 別プロセスが同じ投稿を先に積んでいたら何もしない。
      .onConflictDoNothing({ target: nagiCommunityAffirmations.sourceUri });

    recent.set(authorDid, stocked + 1);
    enqueued += 1;
    logCommunityAffirmation("candidate_queued", {
      authorDid,
      sourceUri: candidate.post.uri,
      sourceCid: candidate.post.cid,
      reason: "scheduled",
      promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
    });
  }
}

async function loadInput(
  job: typeof nagiCommunityAffirmations.$inferSelect,
): Promise<CommunityAffirmationInput | undefined> {
  // 投稿時刻とリアクション数は、初回なら eligibleCandidates、再生成なら
  // requeueStalePromptVersions で判定済み。処理時に再適用すると、キュー投入後の
  // 時間経過やリアクション増加だけで既存カードを reject してしまう。
  const [source] = await db
    .select({
      post: nagiPosts,
      pdsUrl: nagiActors.pdsUrl,
    })
    .from(nagiPosts)
    .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
    .where(
      and(
        eq(nagiPosts.uri, job.sourceUri),
        eq(nagiPosts.cid, job.sourceCid),
        isNull(nagiPosts.deletedAt),
        isNull(nagiPosts.replyParentUri),
        ne(nagiPosts.did, process.env.NAGI_BOT_DID!),
      ),
    )
    .limit(1);
  if (!source || hasCommunityAffirmationContentWarning(source.post))
    return undefined;

  const record = source.post.recordJson as any;
  const pdsUrl =
    source.pdsUrl ?? (await resolvePdsUrl(source.post.did).catch(() => ""));
  if (
    Array.isArray(source.post.embedImages) &&
    source.post.embedImages.length &&
    !pdsUrl
  )
    throw new Error("Failed to resolve the source PDS for attached images");
  const images: NonNullable<CommunityAffirmationInput["images"]> =
    blobImagesToImageRefs(
      source.post.did,
      pdsUrl,
      source.post.embedImages as any,
    ).map((image) => ({ ...image, origin: "direct" as const }));

  let quoteText: string | undefined;
  if (source.post.quoteUri) {
    const [quote] = await db
      .select({ post: nagiPosts, pdsUrl: nagiActors.pdsUrl })
      .from(nagiPosts)
      .leftJoin(nagiActors, eq(nagiActors.did, nagiPosts.did))
      .where(
        and(
          eq(nagiPosts.uri, source.post.quoteUri),
          isNull(nagiPosts.deletedAt),
        ),
      )
      .limit(1);
    // 引用元を取得できない、または引用元にCWがある場合は、文脈を欠いた要約を作らない。
    if (!quote || hasCommunityAffirmationContentWarning(quote.post))
      return undefined;
    quoteText = quote.post.text;
    const quotePds =
      quote.pdsUrl ?? (await resolvePdsUrl(quote.post.did).catch(() => ""));
    if (
      Array.isArray(quote.post.embedImages) &&
      quote.post.embedImages.length &&
      !quotePds
    )
      throw new Error("Failed to resolve the quoted source PDS for images");
    images.push(
      ...blobImagesToImageRefs(
        quote.post.did,
        quotePds,
        quote.post.embedImages as any,
      ).map((image) => ({ ...image, origin: "quote" as const })),
    );
  }

  const linkCards = Array.isArray(record?.linkCards)
    ? record.linkCards.flatMap((card: any) =>
        typeof card?.title === "string" || typeof card?.description === "string"
          ? [
              {
                title: typeof card.title === "string" ? card.title : undefined,
                description:
                  typeof card.description === "string"
                    ? card.description
                    : undefined,
              },
            ]
          : [],
      )
    : undefined;
  if (
    !source.post.text.trim() &&
    !images.length &&
    !quoteText &&
    !linkCards?.length
  )
    return undefined;
  return {
    text: source.post.text,
    quoteText,
    linkCards,
    images,
  };
}

async function processOne(now: Date) {
  const [job] = await db
    .select()
    .from(nagiCommunityAffirmations)
    .where(
      and(
        or(
          eq(nagiCommunityAffirmations.state, "pending"),
          eq(nagiCommunityAffirmations.state, "processing"),
        ),
        lte(nagiCommunityAffirmations.nextAttemptAt, now),
        or(
          eq(nagiCommunityAffirmations.state, "pending"),
          lte(nagiCommunityAffirmations.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(nagiCommunityAffirmations.nextAttemptAt))
    .limit(1);
  if (!job) return;

  // 候補の読み取り後に同じ行を別プロセスが先にリースしていても、
  // availability条件が変わるため片方だけがreturningを得る。
  const [leasedJob] = await db
    .update(nagiCommunityAffirmations)
    .set({
      state: "processing",
      attempts: job.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(nagiCommunityAffirmations.authorDid, job.authorDid),
        eq(nagiCommunityAffirmations.sourceUri, job.sourceUri),
        eq(nagiCommunityAffirmations.sourceCid, job.sourceCid),
        eq(nagiCommunityAffirmations.attempts, job.attempts),
        or(
          eq(nagiCommunityAffirmations.state, "pending"),
          and(
            eq(nagiCommunityAffirmations.state, "processing"),
            lte(nagiCommunityAffirmations.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  if (!leasedJob) return;
  logCommunityAffirmation("generation_started", {
    authorDid: leasedJob.authorDid,
    sourceUri: leasedJob.sourceUri,
    sourceCid: leasedJob.sourceCid,
    attempt: leasedJob.attempts,
    promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
  });

  try {
    const input = await loadInput(leasedJob);
    const result = input
      ? await generateCommunityAffirmation(input)
      : {
          publishable: false,
          summaryJa: "",
          summaryEn: "",
          reasonCode: "insufficient_context",
        };
    const updated = await db
      .update(nagiCommunityAffirmations)
      .set({
        state: result.publishable ? "posted" : "rejected",
        summaryJa: result.publishable ? result.summaryJa : null,
        summaryEn: result.publishable ? result.summaryEn : null,
        leaseExpiresAt: null,
        lastError: result.publishable ? null : result.reasonCode,
        model: aiModel("NAGI_COMMUNITY_AFFIRMATION"),
        promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nagiCommunityAffirmations.authorDid, leasedJob.authorDid),
          eq(nagiCommunityAffirmations.sourceUri, leasedJob.sourceUri),
          eq(nagiCommunityAffirmations.sourceCid, leasedJob.sourceCid),
          eq(nagiCommunityAffirmations.state, "processing"),
          eq(nagiCommunityAffirmations.attempts, leasedJob.attempts),
          eq(
            nagiCommunityAffirmations.leaseExpiresAt,
            leasedJob.leaseExpiresAt!,
          ),
        ),
      )
      .returning({ authorDid: nagiCommunityAffirmations.authorDid });
    if (updated.length)
      logCommunityAffirmation(
        result.publishable ? "generation_published" : "generation_rejected",
        {
          authorDid: leasedJob.authorDid,
          sourceUri: leasedJob.sourceUri,
          sourceCid: leasedJob.sourceCid,
          attempt: leasedJob.attempts,
          promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
          ...(result.publishable ? {} : { reasonCode: result.reasonCode }),
        },
      );
  } catch (error) {
    const attempts = leasedJob.attempts;
    const { failed, backoffMs } = communityAffirmationRetry(attempts);
    const updated = await db
      .update(nagiCommunityAffirmations)
      .set({
        state: failed ? "failed" : "pending",
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(nagiCommunityAffirmations.authorDid, leasedJob.authorDid),
          eq(nagiCommunityAffirmations.sourceUri, leasedJob.sourceUri),
          eq(nagiCommunityAffirmations.sourceCid, leasedJob.sourceCid),
          eq(nagiCommunityAffirmations.state, "processing"),
          eq(nagiCommunityAffirmations.attempts, leasedJob.attempts),
          eq(
            nagiCommunityAffirmations.leaseExpiresAt,
            leasedJob.leaseExpiresAt!,
          ),
        ),
      )
      .returning({ authorDid: nagiCommunityAffirmations.authorDid });
    if (updated.length)
      logCommunityAffirmation(
        failed ? "generation_failed" : "generation_retry_scheduled",
        {
          authorDid: leasedJob.authorDid,
          sourceUri: leasedJob.sourceUri,
          sourceCid: leasedJob.sourceCid,
          attempt: attempts,
          maxAttempts: MAX_ATTEMPTS,
          ...(failed ? {} : { nextAttemptInMs: backoffMs }),
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : String(error).slice(0, 500),
        },
      );
  }
}

let running = false;
let lastCandidateRefresh = 0;

export function startNagiCommunityAffirmationWorker() {
  if (running) return;
  running = true;
  logCommunityAffirmation("worker_started", {
    workerIntervalMs: WORKER_INTERVAL_MS,
    candidateRefreshMs: CANDIDATE_REFRESH_MS,
    promptVersion: COMMUNITY_AFFIRMATION_PROMPT_VERSION,
  });
  const tick = async () => {
    const now = new Date();
    if (now.getTime() - lastCandidateRefresh >= CANDIDATE_REFRESH_MS) {
      lastCandidateRefresh = now.getTime();
      await refreshCandidates(now);
    }
    await processOne(now);
  };
  void tick().catch(console.error);
  setInterval(() => void tick().catch(console.error), WORKER_INTERVAL_MS);
}
