import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const nagiSchema = pgSchema("nagi");

// pgvector 型（affirmative_bot 側 schema.ts と同じ定義）。snowflake-arctic-embed2 = 1024次元。
const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[/, "").replace(/\]$/, "").split(",").map(Number);
  },
});
export const notificationType = nagiSchema.enum("notification_type", [
  "reply",
  "reaction",
  "mention",
  "diary",
  // 自動分析（名刺）の更新。ingest 起点ではなく nagi_bot_server → AppView の
  // 内部エンドポイント経由で作られる唯一の種別。
  "analysis",
]);
export const botJobState = nagiSchema.enum("bot_job_state", [
  "pending",
  "processing",
  "posted",
  "failed",
]);
export const communityAffirmationState = nagiSchema.enum(
  "community_affirmation_state",
  ["pending", "processing", "posted", "rejected", "failed"],
);
export const newsReviewState = nagiSchema.enum("news_review_state", [
  "pending",
  "processing",
  "approved",
  "rejected",
  "failed",
  "cancelled",
]);
export const nagiAiReplyMode = nagiSchema.enum("ai_reply_mode", [
  "ai",
  "template",
]);
export const cardDrawSource = nagiSchema.enum("card_draw_source", [
  "my_nagi",
  "reaction",
]);
/** ミュート対象の種別。actor は相手の DID、channel はチャンネルの AT-URI を指す。 */
export const muteSubjectType = nagiSchema.enum("mute_subject_type", [
  "actor",
  "channel",
]);

export const nagiActors = nagiSchema.table("actors", {
  did: text("did").primaryKey(),
  handle: text("handle").notNull(),
  pdsUrl: text("pds_url").notNull(),
  status: text("status").default("active").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const nagiPosts = nagiSchema.table(
  "posts",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    rkey: text("rkey").notNull(),
    did: text("did").notNull(),
    text: text("text").notNull(),
    facets: jsonb("facets"),
    // facets の #tag feature から抽出した小文字タグ配列。タグ絞り込み（/search）用。
    // 既存行は NULL（バックフィルなし）。新規/更新投稿から populate される。
    tags: text("tags").array(),
    langs: jsonb("langs"),
    recordJson: jsonb("record_json"),
    /** 現在CIDについてAmaterasが返した表示用ラベル。署名ラベル本体はLabelerが保持する。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** nullは未評価の既存行。ルール更新時は値を変えて再評価できる。 */
    moderationVersion: text("moderation_version"),
    replyRootUri: text("reply_root_uri"),
    replyParentUri: text("reply_parent_uri"),
    embedImages: jsonb("embed_images"),
    quoteUri: text("quote_uri"),
    quoteCid: text("quote_cid"),
    quoteValid: boolean("quote_valid").default(false).notNull(),
    // こっそりはスレッドルートだけが所有する。返信の共有可否はこの行自身ではなく
    // replyRootUri の参照先から解決し、プロフィール・スレッドからは引き続き見える。
    kossori: boolean("kossori").default(false).notNull(),
    // 所属チャンネル（com.suibari.nagi.channel）の AT-URI。こっそりと同じくスレッドルートが
    // 所有し、返信はレコードに channel を持たない。取り込み時に reply_root_uri から解決して
    // ここへ非正規化コピーするので、CH TL はこの1列だけで引ける（ルート取り込み時に配下へ伝播）。
    channelUri: text("channel_uri"),
    // true なら CH 限定＝グローバル/全肯定TL非表示（kossori と同じ除外扱い）。CH TLには出る。
    channelOnly: boolean("channel_only").default(false).notNull(),
    // 正本が PDS ではなくこのテーブルにしかない行（＝新方式のこっそり投稿と、その返信）。
    // 可視性の判定は kossori 列が持つので、この列は「保管場所」だけを表す:
    // reconcile の削除対象から外し、削除は PDS ではなく XRPC 経由にする。
    // 既存のこっそり投稿は PDS に正本があるので false のまま（バックフィルなし）。
    appviewOnly: boolean("appview_only").default(false).notNull(),
    repoRev: text("repo_rev"),
    recordCreatedAt: timestamp("record_created_at", {
      withTimezone: true,
    }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // 投稿後編集の検知フラグ。ライブで cid 変化を観測した編集で true になり、以後戻さない
    // （単調）。バックフィルなし＝機能導入後に観測した編集のみ。UI の「編集済み」バッジ用。
    edited: boolean("edited").default(false).notNull(),
    // 意味検索(NL検索の土台)用の本文埋め込み。Ollama(snowflake-arctic-embed2/1024次元)で
    // 生成し、EmbeddingWorker が embedding IS NULL を非同期で埋める。編集(cid変化)時は NULL に
    // 戻して再生成対象化する。バックフィルは同 worker が兼ねる。
    embedding: vector("embedding", { dimensions: 1024 }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("nagi_posts_timeline_idx").on(t.indexedAt, t.uri),
    index("nagi_posts_parent_idx").on(t.replyParentUri),
    // ルート取り込み時に配下の返信へ channel_uri を配るための索引。
    index("nagi_posts_reply_root_idx").on(t.replyRootUri),
    index("nagi_posts_actor_idx").on(t.did, t.indexedAt),
    index("nagi_posts_channel_idx").on(t.channelUri, t.indexedAt),
    index("nagi_posts_tags_idx").using("gin", t.tags),
    // 意味検索: cosine 近傍。小さいテーブルでも使える HNSW。
    index("nagi_posts_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    // 語彙検索: 日本語も部分一致できるよう trigram GIN（要 pg_trgm 拡張）。
    index("nagi_posts_text_trgm_idx").using("gin", t.text.op("gin_trgm_ops")),
  ],
);

/**
 * AppViewへ本文を保存しないと判断した投稿の最小tombstone。
 * PDSが真実源なので本文・画像・record_json・OpenAIのraw responseは保持しない。
 */
export const nagiModerationRejections = nagiSchema.table(
  "moderation_rejections",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    category: text("category").notNull(),
    labels: text("labels").array().notNull(),
    ruleVersion: text("rule_version").default("amateras-v1").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_moderation_rejections_did_idx").on(t.did)],
);
/** ユーザーが作るチャンネル（com.suibari.nagi.channel）。作成者の PDS が真実源。 */
export const nagiChannels = nagiSchema.table(
  "channels",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    rkey: text("rkey").notNull(),
    did: text("did").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    bannerCid: text("banner_cid"),
    pinnedPostUri: text("pinned_post_uri"),
    pinnedPostCid: text("pinned_post_cid"),
    // NL検索(意味検索)用。ソースは name+description。EmbeddingWorker が生成し、CH 編集で
    // name/description が変わったら NULL に戻して再生成する。
    embedding: vector("embedding", { dimensions: 1024 }),
    recordCreatedAt: timestamp("record_created_at", {
      withTimezone: true,
    }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("nagi_channels_idx").on(t.indexedAt),
    index("nagi_channels_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("nagi_channels_name_trgm_idx").using(
      "gin",
      t.name.op("gin_trgm_ops"),
    ),
  ],
);
/** PDSから取り込んだニュース本体。承認はCID単位で別表に保持する。 */
export const nagiNews = nagiSchema.table(
  "news",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    rkey: text("rkey").notNull(),
    did: text("did").notNull(),
    articleId: text("article_id").notNull(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    titleJa: text("title_ja").notNull(),
    sourceName: text("source_name"),
    sourceUrl: text("source_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    langs: jsonb("langs"),
    // NL検索(意味検索)用。ソースは titleJa[+sourceName]。EmbeddingWorker が生成し、titleJa が
    // 変わったら NULL に戻して再生成する。
    embedding: vector("embedding", { dimensions: 1024 }),
    recordCreatedAt: timestamp("record_created_at", {
      withTimezone: true,
    }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("nagi_news_article_id_idx").on(t.articleId),
    index("nagi_news_normalized_url_idx").on(t.normalizedUrl),
    index("nagi_news_feed_idx").on(t.indexedAt, t.uri),
    index("nagi_news_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("nagi_news_title_trgm_idx").using(
      "gin",
      t.titleJa.op("gin_trgm_ops"),
    ),
  ],
);
/** AI・管理者による審査結果。ニュース編集でCIDが変わると古い承認は適用されない。 */
export const nagiNewsApprovals = nagiSchema.table(
  "news_approvals",
  {
    newsUri: text("news_uri").notNull(),
    newsCid: text("news_cid").notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    botCommentJa: text("bot_comment_ja"),
    titleEn: text("title_en"),
    botCommentEn: text("bot_comment_en"),
    snapshotArticleId: text("snapshot_article_id"),
    snapshotUrl: text("snapshot_url"),
    snapshotTitleJa: text("snapshot_title_ja"),
    snapshotSourceName: text("snapshot_source_name"),
    snapshotSourceUrl: text("snapshot_source_url"),
    snapshotPublishedAt: timestamp("snapshot_published_at", {
      withTimezone: true,
    }),
    snapshotCreatedAt: timestamp("snapshot_created_at", { withTimezone: true }),
    model: text("model"),
    promptVersion: text("prompt_version"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.newsUri, t.newsCid] })],
);
/** ユーザーが明示的に審査依頼したニュースだけを処理する非公開ジョブ。 */
export const nagiNewsReviewJobs = nagiSchema.table(
  "news_review_jobs",
  {
    newsUri: text("news_uri").notNull(),
    newsCid: text("news_cid").notNull(),
    did: text("did").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    status: newsReviewState("status").default("pending").notNull(),
    reasonCode: text("reason_code"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.newsUri, t.newsCid] }),
    index("nagi_news_review_jobs_pending_idx").on(t.status, t.requestedAt),
    index("nagi_news_review_jobs_did_idx").on(t.did, t.requestedAt),
  ],
);
/** 24時間の不採用・Gemma判定キャッシュ。 */
export const nagiNewsScreening = nagiSchema.table("news_screening", {
  cacheKey: text("cache_key").primaryKey(),
  articleId: text("article_id").notNull(),
  decision: text("decision").notNull(),
  reasonCode: text("reason_code").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
/** 6時間枠の排他と日次上限集計に使う更新実行記録。 */
export const nagiNewsUpdateRuns = nagiSchema.table("news_update_runs", {
  slot: timestamp("slot", { withTimezone: true }).primaryKey(),
  status: text("status").notNull(),
  publishedCount: integer("published_count").default(0).notNull(),
  newsDataCredits: integer("newsdata_credits").default(0).notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const nagiPostScores = nagiSchema.table("post_scores", {
  postUri: text("post_uri").primaryKey(),
  score: integer("score").notNull(),
  botReplyUri: text("bot_reply_uri"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const nagiReactions = nagiSchema.table(
  "reactions",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    subjectUri: text("subject_uri").notNull(),
    // Unicode 絵文字そのもの、またはカスタム絵文字のフォールバックテキスト（":name:"）。
    emoji: text("emoji").notNull(),
    // カスタム絵文字のとき blue.moji.collection.item の AT-URI。Unicode なら null。
    emojiUri: text("emoji_uri"),
    // 重複判定用のキー。emojiUri ?? emoji。
    emojiKey: text("emoji_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("nagi_reaction_actor_subject_emoji_key_idx").on(
      t.did,
      t.subjectUri,
      t.emojiKey,
    ),
    index("nagi_reaction_subject_idx").on(t.subjectUri),
  ],
);
export const nagiEmojis = nagiSchema.table(
  "emojis",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    // ":name:" 形式のエイリアス。
    name: text("name").notNull(),
    alt: text("alt"),
    // 固定 Bluemoji Lexicon から選んだ表示資産 { version: 1, asset: ... }。
    formats: jsonb("formats").notNull(),
    adultOnly: boolean("adult_only").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_emoji_did_name_idx").on(t.did, t.name),
    index("nagi_emoji_name_idx").on(t.name),
  ],
);
export const nagiProfiles = nagiSchema.table(
  "profiles",
  {
    did: text("did").primaryKey(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    avatarCid: text("avatar_cid"),
    // NL検索(意味検索)用のプロフィール埋め込み。ソースは displayName+description に、あれば
    // botたん分析(nagiActorAnalyses.analysisJa)を連結したもの。EmbeddingWorker が生成し、
    // プロフィール編集・分析更新で NULL に戻して再生成する。
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_profiles_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
    index("nagi_profiles_display_name_trgm_idx").using(
      "gin",
      t.displayName.op("gin_trgm_ops"),
    ),
  ],
);
/**
 * botたんが書いたユーザーの日記（com.suibari.nagi.diary）。
 * ポストではないのでタイムラインには一切出ず、通知とプロフィールの日記タブからのみ参照する。
 */
export const nagiDiaries = nagiSchema.table(
  "diaries",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    /** 書き手。bot 以外は取り込まない。 */
    did: text("did").notNull(),
    /** 日記の対象ユーザー。 */
    subjectDid: text("subject_did").notNull(),
    /** ユーザーのローカル日付 "YYYY-MM-DD"。 */
    diaryDate: text("diary_date").notNull(),
    text: text("text").notNull(),
    titleJa: text("title_ja"),
    titleEn: text("title_en"),
    emoji: text("emoji"),
    postCount: integer("post_count"),
    // その日の材料にこっそり投稿が1つ以上含まれる日記。本人以外には本文・タイトル・
    // つながりを返さず（日付と件数だけ返すのでコミットグラフには出る）、botたんの PDS にも
    // レコードを作らない。既存行は false のまま（バックフィルなし）。
    isPrivate: boolean("is_private").default(false).notNull(),
    langs: jsonb("langs"),
    recordCreatedAt: timestamp("record_created_at", {
      withTimezone: true,
    }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "nagi_diaries_post_count_positive",
      sql`${t.postCount} IS NULL OR ${t.postCount} > 0`,
    ),
    uniqueIndex("nagi_diary_subject_date_idx").on(t.subjectDid, t.diaryDate),
    index("nagi_diary_subject_idx").on(t.subjectDid, t.diaryDate),
  ],
);
export const nagiNotifications = nagiSchema.table(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientDid: text("recipient_did").notNull(),
    type: notificationType("type").notNull(),
    actorDid: text("actor_did").notNull(),
    subjectUri: text("subject_uri").notNull(),
    reasonUri: text("reason_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("nagi_notification_reason_idx").on(t.recipientDid, t.reasonUri),
    index("nagi_notification_inbox_idx").on(t.recipientDid, t.createdAt),
  ],
);
export const nagiTranslations = nagiSchema.table(
  "translations",
  {
    postUri: text("post_uri").notNull(),
    targetLang: text("target_lang").notNull(),
    text: text("text").notNull(),
    cacheVersion: integer("cache_version").default(1).notNull(),
    // "mt" = 翻訳モデルの出力。"authored" = botたん本人が生成した対訳の投入。
    // 投稿直後の英訳プリウォームが数秒遅れて完了するため、何もしないと MT が
    // シード済みの対訳を上書きしてしまう。authored は MT に上書きさせない
    // （generateAndCache の setWhere で守る）。
    source: text("source").default("mt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.postUri, t.targetLang] })],
);
export const nagiIngestState = nagiSchema.table("ingest_state", {
  key: text("key").primaryKey(),
  cursor: bigint("cursor", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const nagiProcessedEvents = nagiSchema.table("processed_events", {
  id: text("id").primaryKey(),
  timeUs: bigint("time_us", { mode: "number" }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const nagiBotReplyJobs = nagiSchema.table(
  "bot_reply_jobs",
  {
    sourceUri: text("source_uri").primaryKey(),
    sourceCid: text("source_cid").notNull(),
    authorDid: text("author_did").notNull(),
    recordJson: jsonb("record_json").notNull(),
    state: botJobState("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    replyUri: text("reply_uri"),
    score: integer("score"),
    lastError: text("last_error"),
    generationMode: nagiAiReplyMode("generation_mode"),
    limitReason: text("limit_reason"),
    modeDecidedAt: timestamp("mode_decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_bot_jobs_ready_idx").on(t.state, t.nextAttemptAt),
    index("nagi_bot_jobs_ai_quota_idx").on(
      t.authorDid,
      t.generationMode,
      t.modeDecidedAt,
    ),
  ],
);
/**
 * 「みんなで全肯定」の匿名要約兼リースジョブ。
 *
 * 主キーは投稿の URI。以前は authorDid が主キーで「1作者につき生涯1行」だったため、
 * ストック総量がアクティブ作者数で頭打ちになり、一覧がほとんど更新されなかった。
 * いまは1作者から複数ストックでき、占有防止は
 * 「直近24hに作った行数」（NagiCommunityAffirmationWorker の AUTHOR_STOCK_LIMIT）で担保する。
 */
export const nagiCommunityAffirmations = nagiSchema.table(
  "community_affirmations",
  {
    authorDid: text("author_did").notNull(),
    sourceUri: text("source_uri").primaryKey(),
    sourceCid: text("source_cid").notNull(),
    summaryJa: text("summary_ja"),
    summaryEn: text("summary_en"),
    state: communityAffirmationState("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_community_affirmations_ready_idx").on(
      t.state,
      t.nextAttemptAt,
      t.leaseExpiresAt,
    ),
    index("nagi_community_affirmations_eligible_idx").on(t.nextEligibleAt),
    /** 作者ごとの直近ストック数を数えるため（1作者による占有の防止）。 */
    index("nagi_community_affirmations_author_created_idx").on(
      t.authorDid,
      t.createdAt,
    ),
    /** 読み出しは「生成が新しい順」なので、posted だけを更新時刻で引く。 */
    index("nagi_community_affirmations_posted_idx").on(t.state, t.updatedAt),
  ],
);
/**
 * Nagi の有料AI返信が Gemini へ実際に送信される直前の予約台帳。
 * サービス全体枠だけに使うため、DID・投稿URI・本文は保存しない。
 */
export const nagiAiReplyRequests = nagiSchema.table(
  "ai_reply_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_ai_reply_requests_time_idx").on(t.requestedAt)],
);

/**
 * 未サインイン利用者へ返す、期限付きの全肯定ジョブ。
 *
 * 投稿の正本はブラウザの IndexedDB にあり、この表は返信を生成して端末へ渡す間だけの
 * 作業領域。DID や公開 URI は発行せず、accessToken はハッシュだけを保持する。
 */
export const nagiGuestAffirmationJobs = nagiSchema.table(
  "guest_affirmation_jobs",
  {
    id: uuid("id").primaryKey(),
    accessTokenHash: text("access_token_hash").notNull(),
    text: text("text").notNull(),
    language: text("language").notNull(),
    state: botJobState("state").default("pending").notNull(),
    reply: text("reply"),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_guest_affirmation_jobs_ready_idx").on(
      t.state,
      t.nextAttemptAt,
      t.leaseExpiresAt,
    ),
    index("nagi_guest_affirmation_jobs_expiry_idx").on(t.expiresAt),
  ],
);
/**
 * botたんの自動分析（プロフィールの「ひとこと」吹き出し）。did 単位で最新1件を upsert 保存する。
 * source='bluesky'（Nagi初回登録時、Bluesky投稿を分析）/ 'nagi'（Nagi投稿100到達ごと、Nagi投稿+リアクションを分析）。
 * 称号(currentTitle)には干渉しない（本文のみ）。閲覧者の lang で ja/en を出し分ける。
 */
export const nagiActorAnalyses = nagiSchema.table("actor_analyses", {
  did: text("did").primaryKey(),
  analysisJa: text("analysis_ja").notNull(),
  analysisEn: text("analysis_en").notNull(),
  // 以下4列は名刺カード用（prompt_version >= nagi-analysis-v2 で埋まる）。
  // v1 時代の既存行は NULL のままバックフィルしない（次の分析で自然に埋まる）。
  taglineJa: text("tagline_ja"),
  taglineEn: text("tagline_en"),
  tagsJa: text("tags_ja").array(),
  tagsEn: text("tags_en").array(),
  source: text("source").notNull(),
  postCountAt: integer("post_count_at"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
/**
 * 自動分析のリースキュー（nagiBotReplyJobs と同型）。エンキューは AppView ingest が担い、
 * 処理は nagi_bot_server の NagiAnalysisWorker が担う。id は冪等キー
 * （初回=`${did}#first` / 100到達=`${did}#nagi#${count}`）で二重投入を防ぐ。
 */
export const nagiAnalysisJobs = nagiSchema.table(
  "analysis_jobs",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull(),
    source: text("source").notNull(),
    postCountAt: integer("post_count_at"),
    state: botJobState("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_analysis_jobs_ready_idx").on(t.state, t.nextAttemptAt)],
);
// Web Push の購読。endpoint がプッシュサービス上の宛先で自然な一意キー。同一ユーザーが
// 複数デバイス/ブラウザから購読するため did ごとに複数行を持ちうる（did で索引）。
export const nagiPushSubscriptions = nagiSchema.table(
  "push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    recipientDid: text("recipient_did").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** ブラウザ/PWAの1 installation。旧クライアント行は次回登録まで null のまま許容する。 */
    installationId: uuid("installation_id"),
    /** OAuthなしで同じ installation の購読だけを更新するbearer capabilityのSHA-256。 */
    capabilityHash: text("capability_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
  },
  (t) => [
    index("nagi_push_subscription_did_idx").on(t.recipientDid),
    uniqueIndex("nagi_push_subscription_installation_idx")
      .on(t.installationId)
      .where(sql`${t.installationId} is not null`),
  ],
);
/**
 * ビューア単位のミュート。**他ユーザーに公開してはならない情報**なので、PDS レコード
 * （= listRecords で誰でも読める）にはせず AppView だけが持つ。所有者本人の getMutes
 * 以外からは決して外に出さないこと。ミュートは PDS に残らないので他アプリとは共有されず、
 * この DB を作り直すと失われる（Bluesky のミュートと同じトレードオフ）。
 */
export const nagiMutes = nagiSchema.table(
  "mutes",
  {
    muterDid: text("muter_did").notNull(),
    subjectType: muteSubjectType("subject_type").notNull(),
    /** actor なら対象の DID、channel なら channel レコードの AT-URI。 */
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.muterDid, t.subjectType, t.subject] }),
    index("nagi_mutes_muter_idx").on(t.muterDid, t.subjectType),
  ],
);

/**
 * ホームに表示するユーザーの非公開リスト。PDS に置くと listRecords で関係が公開されるため、
 * AppView だけが持つ。owner 本人の認証済み API とホーム抽出条件以外から参照しないこと。
 *
 * v1 は owner ごとに1リスト。将来複数リスト化するときは list_id を追加し、既存行を既定の
 * ホームリストへ移す。相互性・承認・通知を持たない一方向の表示設定である。
 */
export const nagiPrivateListMembers = nagiSchema.table(
  "private_list_members",
  {
    ownerDid: text("owner_did").notNull(),
    memberDid: text("member_did").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerDid, t.memberDid] }),
    check(
      "private_list_members_not_self",
      sql`${t.ownerDid} <> ${t.memberDid}`,
    ),
    index("nagi_private_list_owner_idx").on(t.ownerDid, t.createdAt),
    index("nagi_private_list_member_idx").on(t.memberDid),
  ],
);

/**
 * 本人だけが見られるブックマークフォルダ。PDS へ置くと保存対象が公開されるため、
 * private_list_members と同じく AppView だけが保持する。
 */
export const nagiBookmarkFolders = nagiSchema.table(
  "bookmark_folders",
  {
    // UUID はフォルダ全体で一意。所有権は全操作で ownerDid と合わせて検証する。
    id: uuid("id").defaultRandom().primaryKey(),
    ownerDid: text("owner_did").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("nagi_bookmark_folders_default_idx")
      .on(t.ownerDid)
      .where(sql`${t.isDefault} = true`),
    index("nagi_bookmark_folders_owner_idx").on(t.ownerDid, t.createdAt),
  ],
);

/** URI だけを保持し、本文/CID のスナップショットは保存しない。 */
export const nagiBookmarks = nagiSchema.table(
  "bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerDid: text("owner_did").notNull(),
    folderId: uuid("folder_id").notNull(),
    subjectUri: text("subject_uri").notNull(),
    subjectType: text("subject_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.folderId],
      foreignColumns: [nagiBookmarkFolders.id],
      name: "nagi_bookmarks_folder_fk",
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    uniqueIndex("nagi_bookmarks_owner_subject_idx").on(
      t.ownerDid,
      t.subjectUri,
    ),
    index("nagi_bookmarks_owner_created_idx").on(t.ownerDid, t.createdAt, t.id),
    index("nagi_bookmarks_subject_idx").on(t.subjectUri),
    check(
      "nagi_bookmarks_subject_type_check",
      sql`${t.subjectType} IN ('post', 'news', 'diary')`,
    ),
  ],
);

/** 最後に使ったブックマークフォルダ。本人の端末間だけで同期する。 */
export const nagiBookmarkPreferences = nagiSchema.table(
  "bookmark_preferences",
  {
    did: text("did").primaryKey(),
    lastFolderId: uuid("last_folder_id").references(
      () => nagiBookmarkFolders.id,
      {
        onDelete: "set null",
      },
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_bookmark_preferences_updated_idx").on(t.updatedAt)],
);

/**
 * 本人限定の投稿下書き。画像やサムネイルのバイナリは保存しない。
 * content は AppView が検証したテキスト・参照情報だけを保持する。
 */
export const nagiDrafts = nagiSchema.table(
  "drafts",
  {
    id: uuid("id").primaryKey(),
    ownerDid: text("owner_did").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("nagi_drafts_owner_updated_idx").on(t.ownerDid, t.updatedAt)],
);

/** 「みんなで全肯定」で本人が見送った候補。候補期間と同時に失効する。 */
export const nagiCommunityAffirmationDismissals = nagiSchema.table(
  "community_affirmation_dismissals",
  {
    viewerDid: text("viewer_did").notNull(),
    sourceUri: text("source_uri")
      .notNull()
      .references(() => nagiPosts.uri, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.viewerDid, t.sourceUri] }),
    index("nagi_community_dismissals_expiry_idx").on(t.expiresAt),
  ],
);

/** 投稿・翻訳に関するアカウント設定。UI言語とテーマは端末設定のまま。 */
export const nagiLanguagePreferences = nagiSchema.table(
  "language_preferences",
  {
    did: text("did").primaryKey(),
    postLanguage: text("post_language").notNull(),
    translationLanguage: text("translation_language").notNull(),
    translationProvider: text("translation_provider").notNull(),
    autoTranslate: boolean("auto_translate").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_language_preferences_updated_idx").on(t.updatedAt)],
);

/**
 * 購読（参加）中のチャンネル。private_list_members と同じ設計で、
 * PDS レコードにはせず AppView だけが持ち、認証した本人にしか返さない
 * （どのチャンネルを見ているかは他人に見せてよい情報ではない）。
 */
export const nagiChannelSubscriptions = nagiSchema.table(
  "channel_subscriptions",
  {
    ownerDid: text("owner_did").notNull(),
    channelUri: text("channel_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerDid, t.channelUri] }),
    index("nagi_channel_subscriptions_owner_idx").on(t.ownerDid, t.createdAt),
    index("nagi_channel_subscriptions_channel_idx").on(t.channelUri),
  ],
);

/**
 * 全肯定カード（1日1回引けるトレカ）の「世界に1枚」の実体。
 *
 * **PDS レコードにはしない**（ミュートと同じ判断だが理由は別）。ガチャ結果をユーザー自身の
 * repo に置くと、クライアントが createRecord で AAR を自作できてしまい非改竄性が保てない。
 * また将来の交換は2つの repo にまたがるため原子的に行えない。よって AppView が権威を持つ。
 * この DB を作り直すと所持カードは失われる。
 *
 * id は交換しても不変（所有者が変わっても「その1枚」であり続ける）。botたんコメントは
 * この行に紐づくので、owner_did を差し替えるだけで「交換してもコメントは維持される」が成立する。
 * どのカードかは (card_volume, card_number) で決まり、shared-configs の cards_v{n}.json を指す。
 * **一度リリースした番号は変更禁止**（振り直すとこの列の指す先が変わる）。
 *
 * card_volume = 0 は記念日カードの段。ガチャではなくその日ログインした人に配るもので、
 * card_number = 西暦 * 100 + slot（shared-configs の ANNIVERSARY_SLOTS）。下の一意索引が
 * そのまま「同じ記念日は1年に1枚」を強制するので、記念日は card_draws を使わない。
 */
export const nagiCardInstances = nagiSchema.table(
  "card_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** カード段。cards_v{volume}.json に対応。 */
    cardVolume: integer("card_volume").notNull(),
    /** 段内の通し番号。定義本体（名前/フレーバー/ATK）は JSON 側が真実源で DB には持たない。 */
    cardNumber: integer("card_number").notNull(),
    /** 現所有者。交換で書き換わる唯一の列。 */
    ownerDid: text("owner_did").notNull(),
    /** 最初にこの1枚を引いた人。交換で流通しても出所が追える。 */
    firstOwnerDid: text("first_owner_did").notNull(),
    /** 引いた瞬間に botたんが付けるコメント。NULL = まだ生成待ち（UI はコメント無しで表示）。 */
    commentJa: text("comment_ja"),
    commentEn: text("comment_en"),
    commentModel: text("comment_model"),
    commentPromptVersion: text("comment_prompt_version"),
    /** 同じカードを引き直した回数（初回=1）。将来の交換素材にも使える。 */
    duplicateCount: integer("duplicate_count").default(1).notNull(),
    /**
     * 記念日カード（card_volume = 0）のうち、ユーザーが自分で登録した記念日の名前。
     * 受け取った時点の名前を焼き付けるので、あとで本人が改名しても過去のカードは変わらない。
     * プリセット祝日と Nagi 登録記念日は NULL で、名前は card_number の slot から引く。
     */
    anniversaryLabel: text("anniversary_label"),
    /** 現所有者がこの1枚を手にした時刻（引き直し・交換で更新される）。 */
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // コレクションは「集合」。同種を引き直しても行は増やさず duplicate_count を上げる。
    // 先頭が owner_did なので、コレクション一覧の owner_did 検索もこの索引で足りる。
    uniqueIndex("nagi_card_instance_owner_card_idx").on(
      t.ownerDid,
      t.cardVolume,
      t.cardNumber,
    ),
  ],
);

/**
 * 日次ドローの記録。(did, draw_date, draw_source) の一意索引が通常枠とリアクション枠を
 * それぞれ1日1回に強制する（同時押しでも各枠1枚に収束する）。
 * draw_date は JST 4:00 始まりの "YYYY-MM-DD"（shared-configs の cardDrawDate が算出）。
 */
export const nagiCardDraws = nagiSchema.table(
  "card_draws",
  {
    did: text("did").notNull(),
    drawDate: text("draw_date").notNull(),
    drawSource: cardDrawSource("draw_source").default("my_nagi").notNull(),
    /** リアクション枠を解放した本人所有の reaction AT-URI。通常枠では null。 */
    triggerUri: text("trigger_uri"),
    cardVolume: integer("card_volume").notNull(),
    cardNumber: integer("card_number").notNull(),
    /**
     * 引き当てた実体。日次ロックを先に取る必要があるので insert 時点では未確定で、
     * 同一トランザクション内の直後に埋める（= 実際に NULL のまま残ることはない）。
     */
    instanceId: uuid("instance_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // 新規列を含む複合PKは drizzle-kit push が列追加前に適用して失敗するため、
  // 同等の排他保証を列追加後に作られる一意索引で持つ。
  (t) => [
    uniqueIndex("nagi_card_draw_did_date_source_idx").on(
      t.did,
      t.drawDate,
      t.drawSource,
    ),
    check(
      "card_draws_reaction_trigger_check",
      sql`(${t.drawSource} = 'my_nagi' AND ${t.triggerUri} IS NULL) OR (${t.drawSource} = 'reaction' AND ${t.triggerUri} IS NOT NULL)`,
    ),
  ],
);

/**
 * DID をまだ持たない端末が引いた「今日の1枚」。端末の秘密値は生で保存せずハッシュだけを持つ。
 * expires_at は通常カードと同じ JST 4:00 境界で、期限を越えた行は次の抽選時に削除する。
 * サインイン後は同日の my_nagi 枠へ同じカードを移し、claimed_by_did を記録して再利用を防ぐ。
 */
export const nagiGuestCardDraws = nagiSchema.table(
  "guest_card_draws",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceTokenHash: text("device_token_hash").notNull(),
    drawDate: text("draw_date").notNull(),
    cardVolume: integer("card_volume").notNull(),
    cardNumber: integer("card_number").notNull(),
    claimedByDid: text("claimed_by_did"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("nagi_guest_card_draw_device_date_idx").on(
      t.deviceTokenHash,
      t.drawDate,
    ),
    index("nagi_guest_card_draw_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * botたんコメント生成のリースキュー（nagiAnalysisJobs と同型）。
 * エンキューは AppView の drawCard、処理は nagi_bot_server の NagiCardCommentWorker。
 * instance_id が主キーなので、同じ1枚に対するジョブは常に1件（引き直しでも上書き）。
 */
export const nagiCardCommentJobs = nagiSchema.table(
  "card_comment_jobs",
  {
    instanceId: uuid("instance_id").primaryKey(),
    state: botJobState("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_card_comment_jobs_ready_idx").on(t.state, t.nextAttemptAt),
  ],
);

/**
 * 端末をまたいで同期する「ここまで読んだ」位置。my Nagi の各セクションのドットに使う。
 * ミュートや非公開リストと同じく、PDS レコードにすると「いつ何を読んだか」が公開されて
 * しまうので AppView だけが持ち、認証した本人にしか返さない。
 *
 * 書き込みは単調（monotonic）。(indexed_at, uri) が現在値より進むときだけ更新するため、
 * 復帰の遅れた端末が古い位置を送っても既読が巻き戻らず、端末間のロックが要らない。
 */
export const nagiReadPositions = nagiSchema.table(
  "read_positions",
  {
    did: text("did").notNull(),
    /** "bot" | "community" | "list" | "channels" | "news"。将来の追加に備えて text のまま。 */
    section: text("section").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull(),
    uri: text("uri").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // 主キーがそのまま「本人の全セクションを引く」索引なので、追加の索引は要らない。
  (t) => [primaryKey({ columns: [t.did, t.section] })],
);

/**
 * お気に入り絵文字パレット。順序のある1本の配列で、部分マージに意味が無いため
 * updated_at による後勝ち（last-write-wins）で丸ごと差し替える。
 * choices はクライアントの localStorage と同じ形（ReactionChoice[]）をそのまま入れる。
 */
/**
 * botたんに呼んでほしい名前。
 *
 * これが無かった頃、botたんは displayName から毎回勝手に愛称を作り、同じ相手の
 * 呼び方が数日のうちに何通りにも揺れた。本人が訂正しても、その訂正を「改名依頼」と
 * 誤解してさらに悪化し、離脱につながった実例がある。
 * displayName 固定にしてブレは止めたが、本人が別の呼び名を望んだときに応える先がここ。
 *
 * **PDS レコードにはしない。** 呼び名は他人に見せる情報ではないうえ、
 * permission-set の再公開コストに見合わない（お気に入り絵文字と同じ判断）。
 *
 * DID をキーにしているので Bluesky 側のリプライからも同じ行を引ける。
 * ただし**書き込むのは Nagi 側だけ**（Bsky bot は撤退方針のため、
 * Bluesky から呼び方を変える経路は作らない）。
 *
 * source は由来。declared = 本人が会話で申告、manual = 設定画面で本人が入力。
 * model / prompt_version は declared のときの判定の出所で、
 * 変な呼び名が入ったときにどの判定が通したかを追うために持つ。
 */
export const nagiPreferredNames = nagiSchema.table("preferred_names", {
  did: text("did").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const nagiEmojiFavorites = nagiSchema.table("emoji_favorites", {
  did: text("did").primaryKey(),
  choices: jsonb("choices").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * フィードのタブ構成（並び順と、追加したチャンネル/検索タブ）。
 * お気に入り絵文字と同じく順序のある1本の配列なので updated_at による後勝ち。
 * 絵文字と同居させないのは、性質の違う2つの設定が1行の updated_at を共有すると
 * 片方の更新でもう片方の後勝ち判定が壊れるため。
 * 行が無い＝一度もカスタムしていない（クライアントは既定タブを使う）。
 */
export const nagiFeedTabs = nagiSchema.table("feed_tabs", {
  did: text("did").primaryKey(),
  tabs: jsonb("tabs").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
