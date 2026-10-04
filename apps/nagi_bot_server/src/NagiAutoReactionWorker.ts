/**
 * botたんの「最初の1件」リアクション。
 *
 * 何ごとも最初の1件は付けにくい。投稿してから1〜6時間のランダムな時刻に、人間のリアクションが
 * まだ無ければ botたんがカスタム絵文字を1つ付けて呼び水にする。リアクションした人の一覧は
 * 受け取った本人にしか返らない（AppView の groupReactionViews）ので、
 * 第三者には「誰かが最初に反応した」ようにしか見えない。
 *
 * 対象はポスト（ブログ記事を含む）とゼンカツ。予定は nagi.bot_auto_reactions に積み、
 * 判定済みの行は残して同じ subject を二度見ない。
 *
 * ユーザーは結果を待っていない（そもそも来るかどうかを知らない）ので即時起動の口は持たない。
 * Ollama へは常に直列1本（AGENTS.md「定期ワーカーの回し方」）。
 */
import {
  db,
  nagiBotAutoReactions,
  nagiEmojis,
  nagiMutes,
  nagiPosts,
  nagiReactions,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  chooseAutoReactionEmoji,
  isAutoReactionRouteLocal,
  isOllamaConfigured,
  type AutoReactionCandidate,
} from "@bsky-affirmative-bot/bot-brain";
import {
  BLUEMOJI_NAME_RE,
  NAGI,
  type NagiReaction,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  getThemeDef,
  resolveCardDef,
} from "@bsky-affirmative-bot/shared-configs";
import { TID, trackedPutRecord } from "@bsky-affirmative-bot/clients";
import {
  type Column,
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { agent } from "./agent.js";
import { ensureNagiBotRecordIndexed } from "./appviewInternal.js";
import { hasCommunityAffirmationContentWarning } from "./NagiCommunityAffirmationWorker.js";
import { startWorkerLoop } from "./workerLoop.js";

const ONE_HOUR_MS = 60 * 60 * 1_000;
/** 投稿からこの時間が経つまでは判定しない。すぐ付くと人間の最初の1件を奪ってしまう。 */
export const AUTO_REACTION_MIN_DELAY_MS = ONE_HOUR_MS;
/** 判定時刻の上限。これより遅いと本人がもう投稿を見に来ない。 */
export const AUTO_REACTION_MAX_DELAY_MS = 6 * ONE_HOUR_MS;
const TOP_CUSTOM_EMOJIS = 20;
const RANDOM_CUSTOM_EMOJIS = 20;

const WORKER_INTERVAL_MS = 30_000;
const STOCK_REFRESH_MS = 60_000;
const STOCK_SCAN_LIMIT = 200;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 600_000;
const LOG_PREFIX = "[nagi-auto-reaction]";

const log = (event: string, details: Record<string, unknown> = {}) =>
  console.info(LOG_PREFIX, { event, ...details });

const botDid = () => process.env.NAGI_BOT_DID!;

/** 投稿時刻から [1h, 6h] の一様なランダム時刻。 */
export function autoReactionScheduledAt(
  postedAt: Date,
  random: () => number = Math.random,
) {
  const span = AUTO_REACTION_MAX_DELAY_MS - AUTO_REACTION_MIN_DELAY_MS;
  return new Date(
    postedAt.getTime() + AUTO_REACTION_MIN_DELAY_MS + Math.floor(random() * span),
  );
}

/**
 * 書き込み先の rkey。前回の試行で予約した URI があればその rkey を使い回す。
 * 同じ rkey への putRecord は上書きなので、再試行でリアクションが2件にならない。
 */
export function autoReactionRkey(reservedUri: string | null | undefined) {
  return reservedUri ? reservedUri.slice(reservedUri.lastIndexOf("/") + 1) : TID.nextStr();
}

export function autoReactionRetry(attempts: number) {
  return {
    failed: attempts >= MAX_ATTEMPTS,
    backoffMs: Math.min(MAX_BACKOFF_MS, 2 ** attempts * 30_000),
  };
}

type PostRow = Pick<
  typeof nagiPosts.$inferSelect,
  | "uri"
  | "cid"
  | "did"
  | "text"
  | "recordJson"
  | "embedImages"
  | "deletedAt"
  | "replyParentUri"
  | "kossori"
  | "moderationLabels"
  | "selfLabels"
>;

/**
 * ストック時と処理時の両方で使う適格判定。モデレーションのラベルは投稿後に非同期で付くので、
 * 処理時にもう一度見る。こっそり投稿は「静かに置いておきたい」意思表示なので触らない。
 */
export function skipReasonForPost(post: PostRow): string | undefined {
  if (post.deletedAt) return "deleted";
  if (post.replyParentUri) return "reply";
  if (post.did === botDid()) return "bot_post";
  if (post.kossori) return "kossori";
  if (post.moderationLabels.length || post.selfLabels.length) return "labeled";
  if (hasCommunityAffirmationContentWarning(post)) return "content_warning";
  return undefined;
}

/** モデルへ渡す投稿の要約。画像は見せない（負荷を抑えるため）ので、有無だけ添える。 */
export function postSubjectText(
  post: Pick<PostRow, "text" | "recordJson" | "embedImages">,
) {
  const record = post.recordJson as any;
  const lines = [post.text.trim()];
  const linkCards = Array.isArray(record?.linkCards) ? record.linkCards : [];
  for (const card of linkCards) {
    const title = typeof card?.title === "string" ? card.title.trim() : "";
    if (title) lines.push(`（リンク: ${title}）`);
  }
  const images = Array.isArray(post.embedImages) ? post.embedImages.length : 0;
  if (images) lines.push(`（画像${images}枚付き。画像の中身は見えない）`);
  return lines.filter(Boolean).join("\n");
}

export function zenkatsuSubjectText(themeJa: string | undefined, cardNames: string[]) {
  return [
    "ゼンカツ（お題に合わせて手札のカードを出すゲーム）のプレイ記録。",
    themeJa ? `お題: ${themeJa}` : "",
    cardNames.length ? `出したカード: ${cardNames.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type CustomEmojiOption = {
  uri: string;
  cid: string;
  name: string;
  alt: string | null;
};

/**
 * モデルへ見せる候補。botたんのリアクションはカスタム絵文字だけを使う（Unicode より面白いので）。
 * 同名はまとめる（別ユーザーの同名絵文字はモデルから区別できない）。
 * recent（同じ人へ直近に付けた絵文字）は外す。同じ絵文字が続くと botたん からだと透けやすく、
 * モデルも汎用の褒め言葉に偏りやすい。
 */
export function autoReactionCandidates(
  custom: readonly CustomEmojiOption[],
  recent: readonly string[] = [],
): AutoReactionCandidate[] {
  return custom
    .filter(
      (emoji, index) =>
        BLUEMOJI_NAME_RE.test(emoji.name) &&
        !recent.includes(emoji.name) &&
        custom.findIndex((other) => other.name === emoji.name) === index,
    )
    .map(({ name, alt }) => ({
      key: name,
      ...(alt?.trim() ? { description: alt.trim().slice(0, 60) } : {}),
    }));
}

/** 選んだ値から PDS へ書くリアクションの中身を作る。emoji は bluemoji.name と一致させる。 */
export function buildAutoReactionRecord(
  subject: { uri: string; cid: string },
  key: string,
  custom: readonly CustomEmojiOption[],
  now = new Date(),
): NagiReaction | undefined {
  const emoji = custom.find(({ name }) => name === key);
  if (!emoji) return undefined;
  return {
    $type: NAGI.reaction,
    subject: { uri: subject.uri, cid: subject.cid },
    emoji: emoji.name,
    bluemoji: {
      uri: emoji.uri,
      cid: emoji.cid,
      name: emoji.name,
      ...(emoji.alt ? { alt: emoji.alt } : {}),
    },
    createdAt: now.toISOString(),
  };
}

/** 投稿者が botたん をミュートしていない。 */
const notMutingBot = (authorDid: Column) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(nagiMutes)
      .where(
        and(
          eq(nagiMutes.muterDid, authorDid),
          eq(nagiMutes.subjectType, "actor"),
          eq(nagiMutes.subject, botDid()),
        ),
      ),
  );

/** 直近6時間の、まだ予定表に無いトップレベル投稿（ブログ記事を含む）。 */
export function postStockQuery(now: Date) {
  return db
    .select({
      uri: nagiPosts.uri,
      cid: nagiPosts.cid,
      did: nagiPosts.did,
      text: nagiPosts.text,
      recordJson: nagiPosts.recordJson,
      embedImages: nagiPosts.embedImages,
      deletedAt: nagiPosts.deletedAt,
      replyParentUri: nagiPosts.replyParentUri,
      kossori: nagiPosts.kossori,
      moderationLabels: nagiPosts.moderationLabels,
      selfLabels: nagiPosts.selfLabels,
      // createdAt は利用者が書ける値で、遡らせれば予定時刻が即過去になり待機を迂回できる。
      // ゼンカツと同じく、サーバが付ける索引時刻を投稿時刻とみなす。
      postedAt: nagiPosts.indexedAt,
    })
    .from(nagiPosts)
    .leftJoin(
      nagiBotAutoReactions,
      eq(nagiBotAutoReactions.subjectUri, nagiPosts.uri),
    )
    .where(
      and(
        isNull(nagiBotAutoReactions.subjectUri),
        isNull(nagiPosts.deletedAt),
        isNull(nagiPosts.replyParentUri),
        ne(nagiPosts.did, botDid()),
        gte(
          nagiPosts.indexedAt,
          new Date(now.getTime() - AUTO_REACTION_MAX_DELAY_MS),
        ),
        notMutingBot(nagiPosts.did),
      ),
    )
    .orderBy(asc(nagiPosts.indexedAt))
    .limit(STOCK_SCAN_LIMIT);
}

/** 直近6時間の、まだ予定表に無いゼンカツの提出。 */
export function zenkatsuStockQuery(now: Date) {
  return db
    .select({
      uri: nagiZenkatsuSubmissions.uri,
      cid: nagiZenkatsuSubmissions.cid,
      did: nagiZenkatsuSubmissions.did,
      // createdAt は利用者が書ける値なので、フィードの並びと同じく索引時刻を投稿時刻とみなす。
      postedAt: nagiZenkatsuSubmissions.indexedAt,
    })
    .from(nagiZenkatsuSubmissions)
    .leftJoin(
      nagiBotAutoReactions,
      eq(nagiBotAutoReactions.subjectUri, nagiZenkatsuSubmissions.uri),
    )
    .where(
      and(
        isNull(nagiBotAutoReactions.subjectUri),
        isNull(nagiZenkatsuSubmissions.deletedAt),
        ne(nagiZenkatsuSubmissions.did, botDid()),
        gte(
          nagiZenkatsuSubmissions.indexedAt,
          new Date(now.getTime() - AUTO_REACTION_MAX_DELAY_MS),
        ),
        notMutingBot(nagiZenkatsuSubmissions.did),
      ),
    )
    .orderBy(asc(nagiZenkatsuSubmissions.indexedAt))
    .limit(STOCK_SCAN_LIMIT);
}

async function stockCandidates(now: Date) {
  const [posts, zenkatsu] = await Promise.all([
    postStockQuery(now),
    zenkatsuStockQuery(now),
  ]);
  const rows: Array<typeof nagiBotAutoReactions.$inferInsert> = [
    ...posts.map((post) => {
      const reason = skipReasonForPost(post);
      return {
        subjectUri: post.uri,
        subjectCid: post.cid,
        subjectDid: post.did,
        kind: "post",
        scheduledAt: autoReactionScheduledAt(post.postedAt),
        // 対象外も行として残し、窓を抜けるまで毎分走査し直さない。
        ...(reason ? { state: "skipped", lastError: reason } : {}),
      };
    }),
    ...zenkatsu.map((submission) => ({
      subjectUri: submission.uri,
      subjectCid: submission.cid,
      subjectDid: submission.did,
      kind: "zenkatsu",
      scheduledAt: autoReactionScheduledAt(submission.postedAt),
    })),
  ];
  if (!rows.length) return;
  await db
    .insert(nagiBotAutoReactions)
    .values(rows)
    .onConflictDoNothing({ target: nagiBotAutoReactions.subjectUri });
}

/**
 * 安全に見せられるカスタム絵文字。adultOnly・自動判定のラベル付き・判定待ち・
 * 表示不能な資産は除く（表示可否の式は AppView の services/emoji.ts displayableEmoji と同じ）。
 */
const safeEmoji = () =>
  and(
    eq(nagiEmojis.adultOnly, false),
    sql<boolean>`cardinality(${nagiEmojis.moderationLabels}) = 0`,
    isNotNull(nagiEmojis.moderationVersion),
    ne(nagiEmojis.moderationVersion, "skipped"),
    sql<boolean>`
      ${nagiEmojis.formats}->>'version' = '1'
      and ${nagiEmojis.formats}->'asset'->>'kind' in ('blob', 'bytes')
      and length(${nagiEmojis.formats}->'asset'->>'value') > 0
      and (
        ${nagiEmojis.formats}->'asset'->>'mediaType' like 'image/%'
        or ${nagiEmojis.formats}->'asset'->>'mediaType' = 'application/lottie+zip'
      )
    `,
  )!;

/** よく使われている上位と、埋もれている絵文字のランダム枠を混ぜて渡す。 */
async function loadCustomEmojiOptions(): Promise<CustomEmojiOption[]> {
  const columns = {
    uri: nagiEmojis.uri,
    cid: nagiEmojis.cid,
    name: nagiEmojis.name,
    alt: nagiEmojis.alt,
  };
  const top = await db
    .select({ ...columns, uses: count(nagiReactions.uri) })
    .from(nagiEmojis)
    .innerJoin(nagiReactions, eq(nagiReactions.emojiUri, nagiEmojis.uri))
    .where(safeEmoji())
    .groupBy(nagiEmojis.uri)
    .orderBy(desc(count(nagiReactions.uri)))
    .limit(TOP_CUSTOM_EMOJIS);
  const random = await db
    .select(columns)
    .from(nagiEmojis)
    .where(
      and(
        safeEmoji(),
        top.length ? notInArray(nagiEmojis.uri, top.map(({ uri }) => uri)) : undefined,
      ),
    )
    .orderBy(sql`random()`)
    .limit(RANDOM_CUSTOM_EMOJIS);
  // 同名は上位側を残す。そのうえで並び順の偏り（先頭ほど選ばれやすい）を避けるため混ぜる。
  const seen = new Set<string>();
  const unique = [...top.map(({ uses: _uses, ...emoji }) => emoji), ...random]
    .filter(({ name }) => !seen.has(name) && Boolean(seen.add(name)));
  return shuffle(unique);
}

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

type Job = typeof nagiBotAutoReactions.$inferSelect;

/** 判定時点の題材。消えていた・対象外になっていたら skip の理由を返す。 */
async function loadSubject(
  job: Job,
): Promise<{ text: string; cid: string } | { skip: string }> {
  if (job.kind === "zenkatsu") {
    const [row] = await db
      .select({
        cid: nagiZenkatsuSubmissions.cid,
        themeVolume: nagiZenkatsuSubmissions.themeVolume,
        themeNumber: nagiZenkatsuSubmissions.themeNumber,
      })
      .from(nagiZenkatsuSubmissions)
      .where(
        and(
          eq(nagiZenkatsuSubmissions.uri, job.subjectUri),
          isNull(nagiZenkatsuSubmissions.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return { skip: "deleted" };
    const cards = await db
      .select({
        cardVolume: nagiZenkatsuCards.cardVolume,
        cardNumber: nagiZenkatsuCards.cardNumber,
      })
      .from(nagiZenkatsuCards)
      .where(eq(nagiZenkatsuCards.submissionUri, job.subjectUri))
      .orderBy(asc(nagiZenkatsuCards.position));
    const theme = getThemeDef(row.themeVolume, row.themeNumber);
    return {
      cid: row.cid,
      text: zenkatsuSubjectText(
        theme?.textJa,
        cards.flatMap((card) => {
          const def = resolveCardDef(card.cardVolume, card.cardNumber);
          return def ? [def.nameJa] : [];
        }),
      ),
    };
  }
  const [post] = await db
    .select({
      uri: nagiPosts.uri,
      cid: nagiPosts.cid,
      did: nagiPosts.did,
      text: nagiPosts.text,
      recordJson: nagiPosts.recordJson,
      embedImages: nagiPosts.embedImages,
      deletedAt: nagiPosts.deletedAt,
      replyParentUri: nagiPosts.replyParentUri,
      kossori: nagiPosts.kossori,
      moderationLabels: nagiPosts.moderationLabels,
      selfLabels: nagiPosts.selfLabels,
    })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, job.subjectUri))
    .limit(1);
  if (!post) return { skip: "deleted" };
  const reason = skipReasonForPost(post);
  if (reason) return { skip: reason };
  // 編集後の本文に、編集前の cid でリアクションを付けない。
  return { cid: post.cid, text: postSubjectText(post) };
}

/**
 * 人間（または botたん自身の既存分）のリアクションがすでにあるか。
 * ownUri は前回の試行で書いた自分のリアクションで、これは数えない（完了させるため）。
 */
async function hasAnyReaction(subjectUri: string, ownUri: string | null) {
  const [row] = await db
    .select({ uri: nagiReactions.uri })
    .from(nagiReactions)
    .where(
      and(
        eq(nagiReactions.subjectUri, subjectUri),
        ownUri ? ne(nagiReactions.uri, ownUri) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function isMutedByAuthor(authorDid: string) {
  const [row] = await db
    .select({ muterDid: nagiMutes.muterDid })
    .from(nagiMutes)
    .where(
      and(
        eq(nagiMutes.muterDid, authorDid),
        eq(nagiMutes.subjectType, "actor"),
        eq(nagiMutes.subject, botDid()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 同じ人へ直近に付けた絵文字（表示上の値）。 */
export const RECENT_EMOJI_WINDOW = 5;

async function recentEmojisFor(subjectDid: string): Promise<string[]> {
  const rows = await db
    .select({ emoji: nagiBotAutoReactions.emojiKey })
    .from(nagiBotAutoReactions)
    .where(
      and(
        eq(nagiBotAutoReactions.subjectDid, subjectDid),
        eq(nagiBotAutoReactions.state, "reacted"),
        isNotNull(nagiBotAutoReactions.emojiKey),
      ),
    )
    .orderBy(desc(nagiBotAutoReactions.updatedAt))
    .limit(RECENT_EMOJI_WINDOW);
  return rows.flatMap(({ emoji }) => (emoji ? [emoji] : []));
}

/** リースを持っている間だけ書き換える（別プロセスが奪い直した行を上書きしない）。 */
const ownsLease = (job: Job) =>
  and(
    eq(nagiBotAutoReactions.subjectUri, job.subjectUri),
    eq(nagiBotAutoReactions.state, "processing"),
    eq(nagiBotAutoReactions.attempts, job.attempts),
    eq(nagiBotAutoReactions.leaseExpiresAt, job.leaseExpiresAt!),
  );

async function finish(
  job: Job,
  values: Partial<typeof nagiBotAutoReactions.$inferInsert>,
) {
  await db
    .update(nagiBotAutoReactions)
    .set({ ...values, leaseExpiresAt: null, updatedAt: new Date() })
    .where(ownsLease(job));
}

async function leaseNext(now: Date): Promise<Job | undefined> {
  const [candidate] = await db
    .select()
    .from(nagiBotAutoReactions)
    .where(
      and(
        lte(nagiBotAutoReactions.scheduledAt, now),
        or(
          eq(nagiBotAutoReactions.state, "pending"),
          and(
            eq(nagiBotAutoReactions.state, "processing"),
            lte(nagiBotAutoReactions.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .orderBy(asc(nagiBotAutoReactions.scheduledAt))
    .limit(1);
  if (!candidate) return undefined;
  const [leased] = await db
    .update(nagiBotAutoReactions)
    .set({
      state: "processing",
      attempts: candidate.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(nagiBotAutoReactions.subjectUri, candidate.subjectUri),
        eq(nagiBotAutoReactions.attempts, candidate.attempts),
        or(
          eq(nagiBotAutoReactions.state, "pending"),
          and(
            eq(nagiBotAutoReactions.state, "processing"),
            lte(nagiBotAutoReactions.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  return leased;
}

async function processOne(now: Date) {
  const job = await leaseNext(now);
  if (!job) return;
  const skip = async (reason: string) => {
    await finish(job, { state: "skipped", lastError: reason });
    log("skipped", { subjectUri: job.subjectUri, reason });
  };

  try {
    const subject = await loadSubject(job);
    if ("skip" in subject) return await skip(subject.skip);
    if (await hasAnyReaction(job.subjectUri, job.reactionUri)) {
      return await skip("already_reacted");
    }
    if (await isMutedByAuthor(job.subjectDid)) return await skip("muted");

    const custom = await loadCustomEmojiOptions();
    const candidates = autoReactionCandidates(
      custom,
      await recentEmojisFor(job.subjectDid),
    );
    // Unicode には倒さない。使える絵文字が無ければ付けずに終える。
    if (!candidates.length) return await skip("no_custom_emoji");
    const key = await chooseAutoReactionEmoji(subject.text, candidates);
    const record = key
      ? buildAutoReactionRecord(
          { uri: job.subjectUri, cid: subject.cid },
          key,
          custom,
        )
      : undefined;
    if (!record) return await skip("no_choice");

    // モデルが考えている数秒の間に誰かが先に反応していたら、そちらを最初の1件にする。
    if (await hasAnyReaction(job.subjectUri, job.reactionUri)) {
      return await skip("already_reacted");
    }

    // 書く前に URI を予約する。PDS へは書けたのに台帳の更新が落ちても、
    // 次の試行は同じ rkey へ上書きするだけになる。
    const rkey = autoReactionRkey(job.reactionUri);
    const reservedUri = `at://${botDid()}/${NAGI.reaction}/${rkey}`;
    if (reservedUri !== job.reactionUri) {
      const reserved = await db
        .update(nagiBotAutoReactions)
        .set({ reactionUri: reservedUri, updatedAt: new Date() })
        .where(ownsLease(job))
        .returning({ subjectUri: nagiBotAutoReactions.subjectUri });
      // 別プロセスにリースを奪われていたら、そちらに任せる。
      if (!reserved.length) return;
    }

    const response = await trackedPutRecord(
      agent,
      {
        repo: botDid(),
        collection: NAGI.reaction,
        rkey,
        validate: false,
        record,
      } as any,
      "nagi.reaction.AUTO_REACTION",
    );
    const created = { uri: response.data.uri, cid: response.data.cid };
    await finish(job, {
      state: "reacted",
      reactionUri: created.uri,
      // ":name:"。同名の別絵文字も「同じ絵文字」として避けるため URI にしない。
      emojiKey: record.emoji,
      lastError: null,
    });
    // Jetstream を待たずに AppView へ載せる。通知と push は ingest が作る。
    await ensureNagiBotRecordIndexed(created);
    log("reacted", {
      subjectUri: job.subjectUri,
      kind: job.kind,
      emoji: record.emoji,
    });
  } catch (error) {
    const { failed, backoffMs } = autoReactionRetry(job.attempts);
    await finish(job, {
      state: failed ? "failed" : "pending",
      // 予定時刻を再試行時刻として使う。
      scheduledAt: new Date(Date.now() + backoffMs),
      lastError:
        error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500),
    });
    console.error(
      `${LOG_PREFIX} failed to react to ${job.subjectUri} (attempt ${job.attempts}/${MAX_ATTEMPTS}):`,
      error,
    );
  }
}

export function isAutoReactionEnabled(
  raw = process.env.NAGI_AUTO_REACTION_ENABLED,
) {
  return raw === undefined || raw === "" || !/^(0|false|off|no)$/i.test(raw);
}

let started = false;
let lastStockRefresh = 0;

export function startNagiAutoReactionWorker() {
  if (started) return;
  if (!isAutoReactionEnabled()) {
    console.info(`${LOG_PREFIX} disabled by NAGI_AUTO_REACTION_ENABLED`);
    return;
  }
  if (!isOllamaConfigured()) {
    console.warn(`${LOG_PREFIX} Ollama is not configured; auto reactions are off`);
    return;
  }
  if (!isAutoReactionRouteLocal()) {
    console.warn(
      `${LOG_PREFIX} AI_ROUTE_NAGI_AUTO_REACTION is not a local Ollama route; auto reactions are off`,
    );
    return;
  }
  started = true;
  log("worker_started", { workerIntervalMs: WORKER_INTERVAL_MS });
  startWorkerLoop({
    name: "NAGI_AUTO_REACTION",
    intervalMs: WORKER_INTERVAL_MS,
    immediate: true,
    tick: async () => {
      const now = new Date();
      if (now.getTime() - lastStockRefresh >= STOCK_REFRESH_MS) {
        lastStockRefresh = now.getTime();
        await stockCandidates(now);
      }
      await processOne(now);
    },
  });
}
