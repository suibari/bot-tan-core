import { AtpAgent } from "@atproto/api";
import {
  db,
  nagiActorAnalyses,
  nagiAnalysisJobs,
  nagiPosts,
  nagiProfiles,
  nagiReactions,
} from "@bsky-affirmative-bot/database";
import {
  generateNagiAnalysis,
  NAGI_ANALYSIS_PROMPT_VERSION,
  type NagiAnalysisInput,
  type NagiAnalysisResult,
} from "@bsky-affirmative-bot/bot-brain";
import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { agent } from "./agent.js";
import { getConcatAuthorFeed } from "./bsky/getConcatAuthorFeed.js";
import { getConcatPosts } from "./bsky/getConcatPosts.js";
import { getPds } from "./bsky/getPds.js";
import { notifyAnalysisUpdated } from "./appviewInternal.js";

export type AnalysisSource = "bluesky" | "nagi";

/** 分析対象の入力。source ごとに集め方が違う。 */
export interface AnalysisJobLike {
  did: string;
  source: string;
  postCountAt: number | null;
}

/**
 * ジョブをキューする（冪等キーで二重投入を防ぐ）。動作確認用の内部エンドポイントからも使う。
 *
 * 冪等キーが決め打ちなので、以前の試行が failed で終わっていると再エンキューが
 * onConflictDoNothing で黙って消え、そのユーザーは二度と分析されない（実際に
 * Gemini 503 でこれを踏んだ）。そのため failed の行だけは pending に戻して蘇生させる。
 */
export async function enqueueAnalysis(params: {
  did: string;
  source: AnalysisSource;
  postCountAt?: number;
  /**
   * 開発用。冪等キーを毎回ユニークにして必ず再エンキューする。
   * 通常の ID は did と postCount で決まるため、同じ条件では2回目以降が
   * onConflictDoNothing で黙って消える（名刺デザインの詰めで再実行できない）。
   */
  force?: boolean;
}): Promise<void> {
  const id = params.force
    ? `${params.did}#manual#${Date.now()}`
    : params.source === "bluesky"
      ? `${params.did}#first`
      : `${params.did}#nagi#${params.postCountAt ?? 0}`;
  const now = new Date();
  await db
    .insert(nagiAnalysisJobs)
    .values({
      id,
      did: params.did,
      source: params.source,
      postCountAt: params.postCountAt ?? null,
    })
    .onConflictDoUpdate({
      target: nagiAnalysisJobs.id,
      set: {
        state: "pending",
        attempts: 0,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      },
      // 走行中(pending/processing)と成功済み(posted)には触らない。setWhere が無いと
      // ワーカーが処理中の行のリースを剥がして二重実行になる。
      setWhere: eq(nagiAnalysisJobs.state, "failed"),
    });
}

/**
 * 分析の材料から外す bot たん自身の DID。
 *
 * リアクション/いいねは「本人が反応した他人の投稿」なので、そこに botたんの投稿が
 * 混ざると、botたんが日記や気まぐれ投稿で書いた趣味（アニメ・ゲーム・音楽）が
 * そのままユーザーの趣味として名刺に載る。実際に、電子工作もアニメもゲームもしない人の
 * 名刺が「#技術愛好家 #アニメ好き #戦略ゲーム」になった（2026-09-12）。
 * プロンプト側の禁止だけに頼らず、材料そのものを落とす。
 * Nagi の botたんと Bluesky の botたんは別アカウントなので、両方を除く。
 */
const botDids = (): string[] => [
  // 本番では NAGI_BOT_DID と BSKY_DID が同じアカウントなので重複を潰す。
  ...new Set(
    [process.env.NAGI_BOT_DID, process.env.BSKY_DID].filter(
      (did): did is string => !!did,
    ),
  ),
];

/** Bluesky 投稿＋いいねを集める（Nagi 初回登録時）。public appview 読み出しで認可不要。 */
async function gatherBlueskyInput(did: string): Promise<NagiAnalysisInput> {
  const profile = await agent.getProfile({ actor: did }).catch(() => undefined);
  const displayName = profile?.data.displayName || profile?.data.handle || did;

  // bot がブロックされている・アカウントが消えている等、何回試しても永久に読めないことがある。
  // throw するとワーカーが全リトライを焼き切って failed で残るだけなので、投稿0件
  // （＝スキップ）に倒す。Nagi 投稿10件到達で source='nagi' の分析が改めて走り、そちらで名刺が出る。
  let posts: string[] = [];
  try {
    const feeds = await getConcatAuthorFeed(did, 100);
    posts = feeds.map((feed) => (feed.post.record as any).text as string);
  } catch (error) {
    console.warn(
      `[WARN][NAGI][ANALYSIS] Failed to collect Bluesky posts for ${did}:`,
      error,
    );
  }

  // いいねは対象ユーザーの PDS から listRecords（原 AnalyzeFeature と同じ）。
  let liked: string[] = [];
  try {
    const pdsAgent = new AtpAgent({ service: await getPds(did) });
    const likeRes = await pdsAgent.com.atproto.repo.listRecords({
      repo: did,
      collection: "app.bsky.feed.like",
      limit: 100,
    });
    const uris = likeRes.data.records
      .map((record) => (record.value as any)?.subject?.uri)
      .filter((uri): uri is string => typeof uri === "string");
    const excluded = botDids();
    liked = (await getConcatPosts(uris))
      .filter((post) => !excluded.includes(post.author.did))
      .map((post) => (post.record as any).text as string);
  } catch (error) {
    console.warn(
      `[WARN][NAGI][ANALYSIS] Failed to collect Bluesky likes for ${did}:`,
      error,
    );
  }

  return { displayName, posts, liked, isSubscriber: false };
}

/** Nagi 投稿（直近100件）＋リアクションを集める（Nagi 投稿100到達時）。 */
async function gatherNagiInput(did: string): Promise<NagiAnalysisInput> {
  const [[profile], postRows, reactionRows] = await Promise.all([
    db
      .select({ displayName: nagiProfiles.displayName })
      .from(nagiProfiles)
      .where(eq(nagiProfiles.did, did)),
    db
      .select({ text: nagiPosts.text })
      .from(nagiPosts)
      .where(and(eq(nagiPosts.did, did), isNull(nagiPosts.deletedAt)))
      .orderBy(desc(nagiPosts.recordCreatedAt))
      .limit(100),
    db
      .select({ text: nagiPosts.text })
      .from(nagiReactions)
      .innerJoin(nagiPosts, eq(nagiPosts.uri, nagiReactions.subjectUri))
      .where(
        and(
          eq(nagiReactions.did, did),
          isNull(nagiPosts.deletedAt),
          ...botDids().map((botDid) => ne(nagiPosts.did, botDid)),
        ),
      )
      .orderBy(desc(nagiReactions.indexedAt))
      .limit(100),
  ]);

  return {
    displayName: profile?.displayName || did,
    posts: postRows.map((row) => row.text),
    liked: reactionRows.map((row) => row.text),
    isSubscriber: false,
  };
}

/** runNagiAnalysis の結果。--sync 実行で中身を目視するために返す。 */
export type NagiAnalysisRunResult =
  | { skipped: true; reason: "no posts" }
  | { skipped: false; result: NagiAnalysisResult; updatedAt: string };

/** runNagiAnalysis の任意指定。 */
export interface NagiAnalysisRunOptions {
  /**
   * 本人への通知（Nagi の通知行 + Web Push）を出すか。既定は出す。
   *
   * 通知は「名刺ができたよ」という本人向けのお知らせなので、初回生成や100投稿ごとの
   * 更新では出したい。一方、プロンプトを直したあとに中身だけ静かに差し替える作り直しでは、
   * 本人に「また更新された」と鳴らす意味が無い。呼び出し側が選べるようにする。
   */
  notify?: boolean;
  /**
   * 生成だけして DB には一切書かない。通知も出さない。
   *
   * プロンプトを直したあと、本番の材料で何が出てくるかを **書き込む前に** 見るための口。
   * 名刺は本人のプロフィールに出るものなので、出来上がりを確認せずに上書きしたくない。
   */
  dryRun?: boolean;
}

/**
 * 1件の分析ジョブを処理する。投稿を集め、botたんの「ひとこと」と名刺用の短文・タグを
 * ja/en で生成し、nagi.actor_analyses に did 単位で upsert する（最新で上書き）。
 */
export async function runNagiAnalysis(
  job: AnalysisJobLike,
  options: NagiAnalysisRunOptions = {},
): Promise<NagiAnalysisRunResult> {
  const input =
    job.source === "bluesky"
      ? await gatherBlueskyInput(job.did)
      : await gatherNagiInput(job.did);

  if (input.posts.length === 0) {
    // 分析対象の投稿が無ければ何もしない（失敗ではなくスキップ）。
    console.log(
      `[INFO][NAGI][ANALYSIS] No posts for ${job.did} (source=${job.source}); skipping.`,
    );
    return { skipped: true, reason: "no posts" };
  }

  const result = await generateNagiAnalysis(input);
  if (!result.analysisJa && !result.analysisEn) {
    throw new Error("generateNagiAnalysis returned empty analysis");
  }

  if (options.dryRun) {
    // ここから下（upsert・埋め込みリセット・通知）を全部やらない。
    return { skipped: false, result, updatedAt: new Date().toISOString() };
  }

  const now = new Date();
  // 名刺用の4項目は v1 プロンプト時代の行では NULL。生成できなかったときも
  // 空配列/空文字ではなく NULL に倒し、「未生成」と「生成した結果が空」を区別できるようにする。
  const cardFields = {
    taglineJa: result.taglineJa || null,
    taglineEn: result.taglineEn || null,
    tagsJa: result.tagsJa.length ? result.tagsJa : null,
    tagsEn: result.tagsEn.length ? result.tagsEn : null,
  };
  await db
    .insert(nagiActorAnalyses)
    .values({
      did: job.did,
      analysisJa: result.analysisJa,
      analysisEn: result.analysisEn,
      ...cardFields,
      source: job.source,
      postCountAt: job.postCountAt,
      model: aiModel("NAGI_ANALYSIS"),
      promptVersion: NAGI_ANALYSIS_PROMPT_VERSION,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: nagiActorAnalyses.did,
      set: {
        analysisJa: result.analysisJa,
        analysisEn: result.analysisEn,
        ...cardFields,
        source: job.source,
        postCountAt: job.postCountAt,
        model: aiModel("NAGI_ANALYSIS"),
        promptVersion: NAGI_ANALYSIS_PROMPT_VERSION,
        updatedAt: now,
      },
    });

  // 分析(analysisJa)は意味検索のプロフィール埋め込みソースなので、更新したら該当ユーザーの
  // 埋め込みを NULL に戻し、AppView の EmbeddingWorker に新しい分析込みで再生成させる。
  await db
    .update(nagiProfiles)
    .set({ embedding: null })
    .where(eq(nagiProfiles.did, job.did));

  const updatedAt = now.toISOString();
  if (options.notify !== false) await notifyAnalysisUpdated(job.did, updatedAt);

  return { skipped: false, result, updatedAt };
}
