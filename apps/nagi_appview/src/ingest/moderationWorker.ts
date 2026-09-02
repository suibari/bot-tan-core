import {
  db,
  nagiBotReplyJobs,
  nagiChannels,
  nagiCommunityAffirmations,
  nagiEmojis,
  nagiModerationDecisions,
  nagiNews,
  nagiNotifications,
  nagiPosts,
  nagiProfiles,
  nagiTranslations,
} from "@bsky-affirmative-bot/database";
import { createHash } from "node:crypto";
import { BLUEMOJI_ITEM, NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, desc, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import {
  emojiAssetUrl,
  evaluateModerationInput,
  moderationEnabled,
  moderationSubject,
  MODERATION_RULE_VERSION,
  type ModerationDecision,
  type ModerationInput,
} from "../services/moderation/index.js";
import {
  notifyDecision,
  recordModerationFailure,
  recordModerationSuccess,
} from "../services/moderation/notify.js";
import { TransientModerationError } from "../services/moderation/openai.js";

/**
 * モデレーション判定を取り込みと非同期に走らせるワーカー。
 *
 * 判定は絶対に取り込み・投稿・botたんの返信を待たせない、というのが最優先の要件。
 * そのため applyMutation は OpenAI を一切呼ばず、`moderation_version IS NULL`
 * （＝判定待ち）のまま行を投影して即コミットする。ここがその行を後から拾う。
 *
 * embeddingWorker と同じく専用のジョブ表は持たない。NULL 列のスキャンにすることで
 * 「新規」「既存バックフィル」「編集で NULL に戻された行」がすべて同じ経路に乗る。
 */

const BATCH_SIZE = 8;
/**
 * 同時実行数。バックフィルをやめて判定待ちが常に少数になったので、レート制限に
 * 当たらないことを優先して低く抑える（開発環境で 429 に当たった経緯がある）。
 */
const CONCURRENCY = 2;
const BUSY_INTERVAL_MS = 1_000;
const IDLE_INTERVAL_MS = 5_000;
/** 連続失敗時のバックオフ。1回目から30秒で、失敗のたびに倍にして15分で頭打ち。 */
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * 次の周回までの待ち時間。サーバが Retry-After を返していればそれを優先し、
 * 無ければ連続失敗回数の指数バックオフにする。
 */
export function moderationBackoffMs(
  consecutiveFailures: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs && retryAfterMs > 0)
    return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(MIN_BACKOFF_MS * 2 ** Math.min(exponent, 10), MAX_BACKOFF_MS);
}

let running = false;
let wakeUp: (() => void) | undefined;

/** cid を持たない行の冪等キー。内容が変われば変わり、内容そのものは復元できない。 */
const contentKey = (...parts: Array<string | null | undefined>): string =>
  createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\n"))
    .digest("hex");

/** 判定待ちの1件。 */
type Pending = {
  uri: string;
  cid: string;
  did: string;
  collection: string;
  input: ModerationInput;
};

type Source = {
  name: string;
  fetchBatch(limit: number): Promise<Pending[]>;
};

const sources: Source[] = [
  {
    name: "posts",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiPosts.uri,
          cid: nagiPosts.cid,
          did: nagiPosts.did,
          recordJson: nagiPosts.recordJson,
        })
        .from(nagiPosts)
        .where(
          and(isNull(nagiPosts.moderationVersion), isNull(nagiPosts.deletedAt)),
        )
        .orderBy(desc(nagiPosts.indexedAt))
        .limit(limit);
      return rows.flatMap((r) => {
        const input = moderationSubject(NAGI.post, r.recordJson, r.did);
        return input
          ? [{ ...r, collection: NAGI.post, input }]
          : // record_json が無い行（旧データ・tombstone）は判定材料が無いので対象外にする。
            [];
      });
    },
  },
  {
    name: "profiles",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          did: nagiProfiles.did,
          displayName: nagiProfiles.displayName,
          description: nagiProfiles.description,
          avatarCid: nagiProfiles.avatarCid,
        })
        .from(nagiProfiles)
        .where(isNull(nagiProfiles.moderationVersion))
        .orderBy(desc(nagiProfiles.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        uri: `at://${r.did}/${NAGI.profile}/self`,
        // プロフィール行は cid を持たないので、内容のハッシュを冪等キーにする。
        // 生の表示名・自己紹介を decisions 表へ書かないためハッシュにしている
        // （PDS が真実源で、判定記録に本文は残さない方針）。
        cid: contentKey(r.displayName, r.description, r.avatarCid),
        did: r.did,
        collection: NAGI.profile,
        input: moderationSubject(
          NAGI.profile,
          {
            displayName: r.displayName,
            description: r.description,
            avatar: r.avatarCid ? { ref: { $link: r.avatarCid } } : undefined,
          },
          r.did,
        )!,
      }));
    },
  },
  {
    name: "channels",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiChannels.uri,
          cid: nagiChannels.cid,
          did: nagiChannels.did,
          name: nagiChannels.name,
          description: nagiChannels.description,
          bannerCid: nagiChannels.bannerCid,
        })
        .from(nagiChannels)
        .where(
          and(
            isNull(nagiChannels.moderationVersion),
            isNull(nagiChannels.deletedAt),
          ),
        )
        .orderBy(desc(nagiChannels.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        uri: r.uri,
        cid: r.cid,
        did: r.did,
        collection: NAGI.channel,
        input: moderationSubject(
          NAGI.channel,
          {
            name: r.name,
            description: r.description,
            banner: r.bannerCid ? { ref: { $link: r.bannerCid } } : undefined,
          },
          r.did,
        )!,
      }));
    },
  },
  {
    name: "emojis",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiEmojis.uri,
          cid: nagiEmojis.cid,
          did: nagiEmojis.did,
          name: nagiEmojis.name,
          alt: nagiEmojis.alt,
          formats: nagiEmojis.formats,
        })
        .from(nagiEmojis)
        .where(isNull(nagiEmojis.moderationVersion))
        .orderBy(desc(nagiEmojis.indexedAt))
        .limit(limit);
      return rows.map((r) => {
        const rkey = r.uri.slice(r.uri.lastIndexOf("/") + 1);
        const asset = (r.formats as any)?.asset;
        return {
          uri: r.uri,
          cid: r.cid,
          did: r.did,
          collection: BLUEMOJI_ITEM,
          input: {
            ...moderationSubject(
              BLUEMOJI_ITEM,
              { name: r.name, alt: r.alt },
              r.did,
            )!,
            // 資産は blob と inline bytes の両方があり、どちらも同じ配信URLに出る。
            imageUrls: emojiAssetUrl(r.did, rkey, r.cid, asset?.mediaType),
          },
        };
      });
    },
  },
  {
    name: "news",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiNews.uri,
          cid: nagiNews.cid,
          did: nagiNews.did,
          titleJa: nagiNews.titleJa,
          sourceName: nagiNews.sourceName,
        })
        .from(nagiNews)
        .where(
          and(isNull(nagiNews.moderationVersion), isNull(nagiNews.deletedAt)),
        )
        .orderBy(desc(nagiNews.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        uri: r.uri,
        cid: r.cid,
        did: r.did,
        collection: NAGI.news,
        input: moderationSubject(
          NAGI.news,
          { titleJa: r.titleJa, sourceName: r.sourceName },
          r.did,
        )!,
      }));
    },
  },
];

/** 規約違反・入力不正と判断した投稿から、AppView 側の投影を落とす。 */
async function rejectPost(uri: string): Promise<void> {
  await db.transaction(async (tx) => {
    // PDS が真実源なので、本文・画像・record_json は AppView に残さない。
    // 既存投稿の編集が拒否された場合も旧本文を復活させず、最小の墓標だけ残す。
    await tx
      .update(nagiPosts)
      .set({
        text: "",
        facets: null,
        tags: null,
        langs: null,
        recordJson: null,
        embedImages: null,
        quoteUri: null,
        quoteCid: null,
        embedding: null,
        selfLabels: [],
        deletedAt: new Date(),
      })
      .where(eq(nagiPosts.uri, uri));
    await tx.delete(nagiTranslations).where(eq(nagiTranslations.postUri, uri));
    await tx
      .delete(nagiNotifications)
      .where(eq(nagiNotifications.subjectUri, uri));
    await tx
      .delete(nagiCommunityAffirmations)
      .where(eq(nagiCommunityAffirmations.sourceUri, uri));
    // まだ返信していないジョブは止める。投稿済みの返信は botたん自身のレコードなので
    // ここでは触らない（botたんの投稿は botたんの判定に従う）。
    await tx.delete(nagiBotReplyJobs).where(eq(nagiBotReplyJobs.sourceUri, uri));
  });
}

/** 判定結果を反映する。reject なら投影を落とし、それ以外はラベルを書く。 */
async function applyDecision(
  item: Pending,
  decision: ModerationDecision,
  labels: string[],
): Promise<void> {
  const reject = decision === "reject-policy" || decision === "reject-invalid";
  switch (item.collection) {
    case NAGI.post:
      if (reject) await rejectPost(item.uri);
      else
        await db
          .update(nagiPosts)
          .set({
            moderationLabels: labels,
            moderationVersion: MODERATION_RULE_VERSION,
          })
          .where(and(eq(nagiPosts.uri, item.uri), eq(nagiPosts.cid, item.cid)));
      return;
    case NAGI.profile:
      if (reject)
        await db.delete(nagiProfiles).where(eq(nagiProfiles.did, item.did));
      else
        await db
          .update(nagiProfiles)
          .set({
            moderationLabels: labels,
            moderationVersion: MODERATION_RULE_VERSION,
          })
          .where(eq(nagiProfiles.did, item.did));
      return;
    case NAGI.channel:
      if (reject)
        await db.delete(nagiChannels).where(eq(nagiChannels.uri, item.uri));
      else
        await db
          .update(nagiChannels)
          .set({
            moderationLabels: labels,
            moderationVersion: MODERATION_RULE_VERSION,
          })
          .where(
            and(eq(nagiChannels.uri, item.uri), eq(nagiChannels.cid, item.cid)),
          );
      return;
    case BLUEMOJI_ITEM:
      if (reject)
        await db.delete(nagiEmojis).where(eq(nagiEmojis.uri, item.uri));
      else
        await db
          .update(nagiEmojis)
          .set({
            moderationLabels: labels,
            moderationVersion: MODERATION_RULE_VERSION,
          })
          .where(
            and(eq(nagiEmojis.uri, item.uri), eq(nagiEmojis.cid, item.cid)),
          );
      return;
    case NAGI.news:
      if (reject) await db.delete(nagiNews).where(eq(nagiNews.uri, item.uri));
      else
        await db
          .update(nagiNews)
          .set({
            moderationLabels: labels,
            moderationVersion: MODERATION_RULE_VERSION,
          })
          .where(and(eq(nagiNews.uri, item.uri), eq(nagiNews.cid, item.cid)));
      return;
  }
}

/**
 * 判定1件のログ。allow でも必ず1行出す。
 *
 * 出さないと「安全と判定された」のか「ワーカーが動いていない」のか区別できない。
 * 量は投稿ペースと同じなので、行あたりの情報を絞って1行に収める。
 */
function logDecision(
  item: Pending,
  decision: ModerationDecision,
  labels: string[],
  category: string,
  score: number,
  cached: boolean,
  elapsedMs: number,
): void {
  const rkey = item.uri.slice(item.uri.lastIndexOf("/") + 1);
  const parts = [
    `[moderation] ${decision}`,
    `${item.collection}/${rkey}`,
    labels.length ? `labels=${labels.join(",")}` : "",
    category ? `top=${category} ${score.toFixed(3)}` : "",
    cached ? "(cached)" : `${elapsedMs}ms`,
  ].filter(Boolean);
  const line = parts.join(" ");
  if (decision === "allow") console.log(line);
  else console.warn(line);
}

/** 判定を1件処理する。再試行したい失敗だけを投げ返す。 */
async function judge(item: Pending): Promise<void> {
  const startedAt = Date.now();
  // 同じ内容を評価済みなら OpenAI を呼ばない。reconcile・再取り込み・
  // ワーカー再起動で同じ行を何度も課金対象にしないため。
  const [cached] = await db
    .select({
      cid: nagiModerationDecisions.cid,
      decision: nagiModerationDecisions.decision,
      labels: nagiModerationDecisions.labels,
      ruleVersion: nagiModerationDecisions.ruleVersion,
    })
    .from(nagiModerationDecisions)
    .where(eq(nagiModerationDecisions.uri, item.uri))
    .limit(1);

  let decision: ModerationDecision;
  let labels: string[];
  let category = "";
  let score = 0;

  const reusedDecision =
    cached?.cid === item.cid && cached.ruleVersion === MODERATION_RULE_VERSION;
  if (reusedDecision) {
    decision = cached!.decision as ModerationDecision;
    labels = cached!.labels;
  } else {
    const evaluation = await evaluateModerationInput(item.input);
    decision = evaluation.decision;
    labels = evaluation.labels;
    category = evaluation.highestCategory;
    score = evaluation.maxScore;

    await db
      .insert(nagiModerationDecisions)
      .values({
        uri: item.uri,
        cid: item.cid,
        did: item.did,
        collection: item.collection,
        decision,
        labels,
        category: category || null,
        score,
        ruleVersion: MODERATION_RULE_VERSION,
      })
      .onConflictDoUpdate({
        target: nagiModerationDecisions.uri,
        set: {
          cid: item.cid,
          decision,
          labels,
          category: category || null,
          score,
          ruleVersion: MODERATION_RULE_VERSION,
          updatedAt: new Date(),
        },
      });

    await notifyDecision({
      decision,
      collection: item.collection,
      uri: item.uri,
      did: item.did,
      labels,
      category,
      score,
      ruleVersion: MODERATION_RULE_VERSION,
      update: !!cached,
    });
  }

  await applyDecision(item, decision, labels);
  logDecision(
    item,
    decision,
    labels,
    category,
    score,
    reusedDecision,
    Date.now() - startedAt,
  );
}

type TickResult = { processed: number; failure?: unknown };

/** 1バッチ処理して、処理できた件数と（あれば）最初の失敗を返す。 */
async function tick(): Promise<TickResult> {
  for (const source of sources) {
    const pending = await source.fetchBatch(BATCH_SIZE);
    if (!pending.length) continue;

    const queue = [...pending];
    let processed = 0;
    let failure: unknown;
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        try {
          await judge(item);
          processed++;
        } catch (error) {
          // 429・5xx・タイムアウト。moderation_version は NULL のまま残るので
          // 次周回で拾い直される。取り込み側は一切影響を受けない。
          failure ??= error;
          console.error(
            `[ERROR][moderationWorker] ${source.name} ${item.uri}:`,
            error,
          );
          // レート制限に当たっているのに残りを投げ続けると事態を悪くするだけ。
          // このバッチは打ち切り、バックオフしてから拾い直す。
          queue.length = 0;
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
    );

    if (processed > 0 && !failure) await recordModerationSuccess();
    return { processed, failure };
  }
  return { processed: 0 };
}

/** 取り込み直後に判定を始めさせる。ポーリング間隔を待たないための合図。 */
export function wakeModerationWorker(): void {
  wakeUp?.();
}

export function startModerationWorker(): void {
  if (running) return;
  if (!moderationEnabled()) {
    console.log(
      "[moderationWorker] disabled (OPENAI_API_KEY is unset); records stay unjudged",
    );
    return;
  }
  running = true;

  const loop = async () => {
    let delay = IDLE_INTERVAL_MS;
    let backingOff = false;
    try {
      const { processed, failure } = await tick();
      if (failure) {
        const failures = await recordModerationFailure(failure);
        const retryAfterMs =
          failure instanceof TransientModerationError
            ? failure.retryAfterMs
            : undefined;
        delay = moderationBackoffMs(failures, retryAfterMs);
        backingOff = true;
        console.warn(
          `[moderationWorker] backing off ${Math.round(delay / 1000)}s (consecutive failures: ${failures})`,
        );
      } else {
        delay = processed > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
      }
    } catch (error) {
      // DB エラーなど tick 自体の想定外。判定の失敗と同じ扱いで下がる。
      console.error("[ERROR][moderationWorker] tick failed:", error);
      delay = MIN_BACKOFF_MS;
      backingOff = true;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeUp = undefined;
        resolve();
      }, delay);
      timer.unref?.();
      // バックオフ中は新規投稿の合図で起こさない。起こしてしまうと投稿のたびに
      // レート制限へ突っ込み直すことになる。
      wakeUp = backingOff
        ? undefined
        : () => {
            clearTimeout(timer);
            wakeUp = undefined;
            resolve();
          };
    });
    void loop();
  };

  void loop();
  console.log(
    `[moderationWorker] started (public url: ${config.publicUrl}, rule: ${MODERATION_RULE_VERSION})`,
  );
  // 判定待ちの残数を起動時に1回だけ出す。バックフィルをやめた後は 0 が正常で、
  // ここが大きい＝マイグレーションの legacy マークが効いていない、と分かる。
  void reportPendingBacklog();
}

async function reportPendingBacklog(): Promise<void> {
  try {
    const counts = await Promise.all(
      sources.map(async (source) => {
        // 実際に拾う経路と同じ条件で数える。BATCH+1 件まで見れば「多いか」は分かる。
        const rows = await source.fetchBatch(BATCH_SIZE + 1);
        return `${source.name}=${rows.length > BATCH_SIZE ? `${BATCH_SIZE}+` : rows.length}`;
      }),
    );
    console.log(`[moderationWorker] pending: ${counts.join(" ")}`);
  } catch (error) {
    console.error("[ERROR][moderationWorker] failed to count pending:", error);
  }
}
