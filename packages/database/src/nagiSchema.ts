import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
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
  /**
   * テーマ抽出を最後に「試した」時刻。NagiThemeWorker のスケジューリング専用。
   *
   * 結果が空でも入れる。「書けた行があるか」で実行済みを判定すると、テーマが
   * 1つも取れない人が候補に残り続けて10秒ごとに回り続ける。
   */
  themesCheckedAt: timestamp("themes_checked_at", { withTimezone: true }),
  /** ニュース突合を最後に「試した」時刻。同上。テーマを取り直したら null に戻す。 */
  newsReasonsCheckedAt: timestamp("news_reasons_checked_at", {
    withTimezone: true,
  }),
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
    /** 現在CIDについて自動判定が付けた表示用ラベル。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** null=判定待ち（ワーカーが拾う） / 'skipped'=対象外 / それ以外はルールバージョン。 */
    moderationVersion: text("moderation_version").default("legacy"),
    /**
     * 投稿者自身がレコードへ付けたセルフラベル。record_json からも取れるが、
     * 未成年ビューアへのフィルタを SQL で書くために列として持つ。
     */
    selfLabels: text("self_labels").array().default([]).notNull(),
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
 * モデレーション判定の記録。allow / label / reject を問わず全件残す。
 *
 * 同一 CID・同一ルールバージョンなら再判定しないための冪等キーであり、
 * drop 閾値を実データの分布から決めるための材料でもある。本文・画像・
 * OpenAI の raw response は保持しない（PDS が真実源のため）。
 */
export const nagiModerationDecisions = nagiSchema.table(
  "moderation_decisions",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    collection: text("collection").notNull(),
    /** allow | label | reject-policy | reject-invalid */
    decision: text("decision").notNull(),
    labels: text("labels").array().default([]).notNull(),
    /** 最高スコアのカテゴリ。判定なしの経路では null。 */
    category: text("category"),
    /** そのカテゴリのスコア。閾値見直しの材料。 */
    score: doublePrecision("score"),
    ruleVersion: text("rule_version").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_moderation_decisions_did_idx").on(t.did),
    index("nagi_moderation_decisions_decision_idx").on(t.decision, t.decidedAt),
  ],
);

/**
 * 年齢確認。生年月日は PDS レコードにすると誰でも読めてしまうので AppView だけが持つ。
 *
 * 行が無い／birth_date が null なら未成年として扱う。source='legacy' は
 * この機能を入れる前からいたユーザーで、一律に成人として扱う。
 * 成人判定は birth_date との日付比較なので、18歳到達時に行を更新する必要はない。
 */
export const nagiAgeAssurance = nagiSchema.table("age_assurance", {
  did: text("did").primaryKey(),
  /** null は未申告（＝未成年扱い）。設定できるのは1度だけ。 */
  birthDate: date("birth_date"),
  /** 18歳未満で利用開始する際の保護者同意の自己申告。 */
  parentalConsentAt: timestamp("parental_consent_at", { withTimezone: true }),
  /** self | legacy */
  source: text("source").notNull(),
  assuredAt: timestamp("assured_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
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
    /** 現在CIDについて自動判定が付けた表示用ラベル。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** null=判定待ち（ワーカーが拾う） / 'skipped'=対象外 / それ以外はルールバージョン。 */
    moderationVersion: text("moderation_version").default("legacy"),
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
    /** 現在CIDについて自動判定が付けた表示用ラベル。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** null=判定待ち（ワーカーが拾う） / 'skipped'=対象外 / それ以外はルールバージョン。 */
    moderationVersion: text("moderation_version").default("legacy"),
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
    /** OGP画像の参照先。画像データ自体は保持せず、クライアントが配信元から直接読む。 */
    snapshotImageUrl: text("snapshot_image_url"),
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
/**
 * 取り込んだが今回のスロットでは掲載しなかったニュース候補の在庫。
 *
 * これまでは NewsData から取った記事のうち、粗選別を通っても MAX_PER_SLOT の枠から
 * あふれたぶんは**その場で捨てていた**（news_screening は判定結果しか持たず、タイトルも
 * URL も残らない）。クレジットを払って取得済みの記事を毎回捨てて次のスロットで取り直す形に
 * なっていて、掲載の母数が上限（日20件）に遠く届かない原因になっていた。
 *
 * ここに積んでおくと、次のスロットは NewsData を叩く前に在庫から審査へ回せる。
 * **在庫は「粗選別を通った未掲載の記事」だけ**。gate が落とした記事（政治・事故・暗い等）は
 * 入れない。ここを緩めると全肯定ニュースの前提が崩れる。
 */
export const nagiNewsCandidates = nagiSchema.table(
  "news_candidates",
  {
    articleId: text("article_id").primaryKey(),
    normalizedUrl: text("normalized_url"),
    url: text("url").notNull(),
    titleJa: text("title_ja").notNull(),
    description: text("description"),
    sourceName: text("source_name"),
    sourceUrl: text("source_url"),
    /** 配信元が返したOGP相当の画像URL。画像データ自体は保存しない。 */
    imageUrl: text("image_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** 在庫の賞味期限。過ぎたら掃除する（古いニュースを今さら出さない）。 */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** 掲載に成功したら埋める。以後は在庫から出さない。 */
    promotedNewsUri: text("promoted_news_uri"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("nagi_news_candidates_ready_idx").on(t.promotedNewsUri, t.expiresAt),
    index("nagi_news_candidates_url_idx").on(t.normalizedUrl),
  ],
);
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
    /** 現在CIDについて自動判定が付けた表示用ラベル。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** null=判定待ち（ワーカーが拾う） / 'skipped'=対象外 / それ以外はルールバージョン。 */
    moderationVersion: text("moderation_version").default("legacy"),
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
    /** 現在CIDについて自動判定が付けた表示用ラベル。 */
    moderationLabels: text("moderation_labels").array().default([]).notNull(),
    /** null=判定待ち（ワーカーが拾う） / 'skipped'=対象外 / それ以外はルールバージョン。 */
    moderationVersion: text("moderation_version").default("legacy"),
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
 * botたんが書いたユーザーの日記（com.suibari.nagi.diary）。本人だけが読む。
 * ポストではないのでタイムラインには一切出ず、通知と本人の日記ページからのみ参照する。
 * PDS には置かず、AppView にだけある（2026-09 以前に PDS へ書いた分は移行スクリプトで移す）。
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
    // その日の材料にこっそり投稿が1つ以上含まれていたかの記録。日記はどれも本人限定に
    // なったので、表示の出し分けには使わない。既存行は false のまま（バックフィルなし）。
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

/** 本人だけに届けるDJ履歴。放送枠ごとに保持する。 */
export const nagiRadioTracks = nagiSchema.table("radio_tracks", {
  subjectDid: text("subject_did").notNull(),
  /** JST の YYYY-MM-DD-HH（08/14/20）。文字列順が時刻順になる。 */
  slotKey: text("slot_key").notNull(),
  status: text("status").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  title: text("title"),
  artist: text("artist"),
  commentJa: text("comment_ja"),
  commentEn: text("comment_en"),
  videoId: text("video_id"),
  videoTitle: text("video_title"),
  songUrl: text("song_url"),
  thumbnailUrl: text("thumbnail_url"),
  sourceUrl: text("source_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.subjectDid, t.slotKey] }),
  index("nagi_radio_tracks_history_idx").on(t.subjectDid, t.slotKey),
  check("nagi_radio_tracks_status_check", sql`${t.status} IN ('pending', 'ready')`),
]);
export const nagiRadioReadStates = nagiSchema.table("radio_read_states", {
  subjectDid: text("subject_did").primaryKey(),
  lastSeenSlotKey: text("last_seen_slot_key").notNull(),
});
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
 * 「おすすめの理由：〜」に出すテーマ。重心は 1024 次元のベクトルなので言葉を持たない。
 *
 * 出典は2つ:
 * - `theme`   … 本人の投稿からローカルLLMが抽出した話題（nagi_bot_server の NagiThemeWorker）
 * - `hashtag` … 本人が実際に付けたハッシュタグ。明示的に自分で選んだテーマなので併存させる
 *
 * **ここに埋め込みは持たせない。** 裸の語のベクトルは記事のベクトルと尺度が合わず
 * （実測で 0.91〜1.06 に潰れ、順位もほぼ乱数）、距離で突合すると平然と嘘の理由が出る。
 * 記事との突合はローカルLLMが nagi.news_reasons へ書き出す。
 */
export const nagiActorInterestKeywords = nagiSchema.table(
  "actor_interest_keywords",
  {
    did: text("did").notNull(),
    keyword: text("keyword").notNull(),
    /** "theme" | "hashtag" */
    source: text("source").notNull(),
    /** hashtag のとき、その語を付けた本人の投稿数。theme では null。 */
    postCount: integer("post_count"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.did, t.keyword] })],
);

/**
 * 全肯定ニュースの推薦に使う、ユーザーごとの広い関心ジャンル。
 *
 * actor_interest_keywords はプロフィールにも出す具体的な話題なので、そのまま残す。
 * 推薦では「作品名と記事見出し」のような細すぎる突合を避けるため、投稿群から別途
 * NEWS_INTEREST_GENRES の語彙へ一般化した結果だけをこの表へ保存する。
 */
export const nagiActorInterestGenres = nagiSchema.table(
  "actor_interest_genres",
  {
    did: text("did").notNull(),
    genre: text("genre").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.did, t.genre] })],
);
/**
 * 「この人の関心ジャンルのうち、この記事はどれに当たるか」のローカルLLM判定結果。
 *
 * リクエスト経路でLLMを呼ぶと直列キューが詰まるので、ワーカーが先に計算して置いておく
 * （モデレーションと同じ「保存してから判定」の形）。`genre` が NULL なら
 * 「どのジャンルにも当たらない」＝理由を出さない、という判定済みの記録。
 */
export const nagiNewsReasons = nagiSchema.table(
  "news_reasons",
  {
    did: text("did").notNull(),
    newsUri: text("news_uri").notNull(),
    /** 当たったジャンル。NULL は「当たらないと判定済み」。 */
    genre: text("genre"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.did, t.newsUri] })],
);
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

/** モデレーションラベルの表示方法。本人の端末間だけで同期する。 */
export const nagiModerationPreferences = nagiSchema.table(
  "moderation_preferences",
  {
    did: text("did").primaryKey(),
    automatic: text("automatic").notNull(),
    selfAi: text("self_ai").notNull(),
    selfNsfw: text("self_nsfw").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "nagi_moderation_preferences_values_check",
      sql`${t.automatic} IN ('warn', 'hide', 'ignore') AND ${t.selfAi} IN ('warn', 'hide', 'ignore') AND ${t.selfNsfw} IN ('warn', 'hide', 'ignore')`,
    ),
    index("nagi_moderation_preferences_updated_idx").on(t.updatedAt),
  ],
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

/**
 * 全肯定ニュースの取得クエリを寄せるための、みんなの関心ジャンル。
 *
 * bot_memory の印象語（作品名・固有名詞）をローカルLLMがジャンルへ一般化した結果を置く。
 * 作品名ではなく「アニメ」のようなジャンルが入る表。取得は広く、選択は細かく、という分担で、
 * 個々の記事が誰に届くかは news_reasons と埋め込み最近傍が決める。
 *
 * 行はワーカーが全入れ替えする（関心は入れ替わるので、古いジャンルを残さない）。
 * ただし last_used_at は入れ替えても持ち越す。消してしまうと、毎回スコア最上位の
 * ジャンルだけが選ばれ続けて回らなくなる。
 */
export const nagiNewsInterestTopics = nagiSchema.table(
  "news_interest_topics",
  {
    /** bot-brain の NEWS_INTEREST_TOPICS に載っているジャンル名だけが入る。 */
    topic: text("topic").primaryKey(),
    /** そのジャンルへ寄せられた印象語の重みの合計。取得の優先順位。 */
    score: integer("score").default(0).notNull(),
    /** そのジャンルへ寄せられた印象語の数。運用確認用。 */
    labelCount: integer("label_count").default(0).notNull(),
    /** 直近でこのジャンルを取得に使った時刻。NULL は未使用。 */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 直近の取得で粗選別を通った件数。空振りが続くジャンルを見つけるため。 */
    lastAcceptedCount: integer("last_accepted_count"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("nagi_news_interest_topics_pick_idx").on(t.lastUsedAt, t.score)],
);

/**
 * ゼンカツ！（1日1回、お題に手持ちのカード1〜3枚で答える遊び）。
 * 設計の経緯と理由は docs/zenkatsu.md を参照。
 *
 * 提出そのものは**ユーザー自身の PDS レコード**（com.suibari.nagi.zenkatsu）で、
 * ここにあるのはその索引。ドローと違い、提出は「既に所持している札を参照するだけ」なので、
 * 所持・お休み・1日1回のすべてを AppView が取り込み時に照合して弾ける
 * （ドローは乱数から価値を生むので照合先が無く、PDS 権威にできない。card_instances 参照）。
 */

/**
 * その日のお題を不変に焼き付ける。
 *
 * お題を「日付 % お題数」で都度計算すると、**themes_v{n}.json にお題を足した瞬間に
 * 過去の日のお題が全部ずれる。** 日付パーマリンクでさかのぼれる仕様なのでアーカイブの破壊になる
 * （リリース済みのカード番号を変更禁止にしているのと同じクラスの問題）。
 *
 * その日を初めて開いたときに INSERT ... ON CONFLICT DO NOTHING で確定させる。以後は変えない。
 */
export const nagiZenkatsuDaily = nagiSchema.table("zenkatsu_daily", {
  /** JST 4:00 始まりの "YYYY-MM-DD"（shared-configs の cardDrawDate が算出）。 */
  themeDate: text("theme_date").primaryKey(),
  /** お題の段。themes_v{volume}.json に対応。 */
  themeVolume: integer("theme_volume").notNull(),
  /** 段内の通し番号。定義本体（本文・追い風）は JSON 側が真実源。 */
  themeNumber: integer("theme_number").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** ユーザーの PDS にある提出レコードの索引。1人1日1件。 */
export const nagiZenkatsuSubmissions = nagiSchema.table(
  "zenkatsu_submissions",
  {
    /** at://did/com.suibari.nagi.zenkatsu/{themeDate}。rkey が日付なので repo 側でも1日1本。 */
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    themeDate: text("theme_date").notNull(),
    /** 提出時点のお題を焼き付ける（zenkatsu_daily と同じ値。表示のたびに join しないため）。 */
    themeVolume: integer("theme_volume").notNull(),
    themeNumber: integer("theme_number").notNull(),
    /** botたんの総評。NULL = 生成待ち（UI はコメント無しで先に記録を出す）。 */
    commentJa: text("comment_ja"),
    commentEn: text("comment_en"),
    commentModel: text("comment_model"),
    commentPromptVersion: text("comment_prompt_version"),
    /**
     * サーバ側で決定論的に計算した「読み」のラベル（追い風の枚数、編成の傾向、初登板など）。
     * 量子化モデルに算術をさせないためにプロンプトへ渡すものだが、
     * ニュースの選別（isHighlight）と記録表示でも使い回すので保存する。
     */
    reading: jsonb("reading").notNull(),
    /** ニュースタブに載せるか。reading から決まる。 */
    isHighlight: boolean("is_highlight").default(false).notNull(),
    /**
     * 隠し得点（1.00 = 100 の整数）。**プレイヤーには絶対に見せない。**
     * 用途は翌朝の「今日のナギカツ部長」の候補を数件に絞ることだけで、合計点も順位も出さない。
     * ATK/DEF は意図的に入れていない（入れると低レアが完全に死ぬ。docs/zenkatsu.md 5章）。
     */
    score: integer("score").default(100).notNull(),
    /** 成立したコンボ（combos_v{n}.json の {volume, id}）。リザルトと発見記録に使う。 */
    combos: jsonb("combos").default([]).notNull(),
    /** レコードに書かれた値。表示用。ユーザーが自由に書けるので並び順には使わない。 */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /**
     * 本人がレコードを消した時刻。**行は消さない。**
     *
     * 物理削除にすると、消して出し直せてしまう（しかも zenkatsu_cards ごと消えるので
     * クールダウンまでリセットされ、気に入る総評が出るまで引き直せる）。
     * 行を残すことで (did, theme_date) の一意索引が再提出を止め、
     * 出した札のクールダウンも生き続ける。記録から見えなくなるだけ。
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * AppView が索引した時刻。**新着順はこちらで並べる。**
     * createdAt はユーザーが自由に書けるので、フィード上位を取るために遡られる。
     */
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 1日1回・先着のみ。レコードが削除されてもこの行は残すので、再提出はできない
    // （「1日1回・確定」を保つ）。
    uniqueIndex("nagi_zenkatsu_submission_did_date_idx").on(t.did, t.themeDate),
    // 日付ページの新着順ページング。
    index("nagi_zenkatsu_submission_feed_idx").on(
      t.themeDate,
      t.indexedAt,
      t.uri,
    ),
    // クールタイム判定（直近7日ぶんの提出を引く）。
    index("nagi_zenkatsu_submission_owner_idx").on(t.did, t.indexedAt),
    // ニュースタブ。
    index("nagi_zenkatsu_submission_highlight_idx").on(
      t.isHighlight,
      t.indexedAt,
    ),
  ],
);

/**
 * 提出した1〜3枚。
 *
 * 子テーブルに分けるのは、クールタイム判定が「この札を直近 D 日に何回出したか」という
 * 札単位の集計だから。カラムに3枚並べるとこの集計が書けない。
 */
export const nagiZenkatsuCards = nagiSchema.table(
  "zenkatsu_cards",
  {
    submissionUri: text("submission_uri").notNull(),
    /** 1..3。プレイヤーが置いた順は意味を持つ（botたんの総評でも順に読む）ので保つ。 */
    position: integer("position").notNull(),
    cardVolume: integer("card_volume").notNull(),
    cardNumber: integer("card_number").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.submissionUri, t.position] }),
    // 「その札が何回出されたか」の逆引き（図鑑やカード詳細から辿る用）。
    index("nagi_zenkatsu_cards_card_idx").on(t.cardVolume, t.cardNumber),
  ],
);

/**
 * botたんの総評を生成するリースキュー（card_comment_jobs と同型）。
 * enqueue は提出レコードを索引した時点、処理は nagi_bot_server の NagiZenkatsuWorker。
 */
export const nagiZenkatsuCommentJobs = nagiSchema.table(
  "zenkatsu_comment_jobs",
  {
    submissionUri: text("submission_uri").primaryKey(),
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
    index("nagi_zenkatsu_comment_jobs_ready_idx").on(t.state, t.nextAttemptAt),
  ],
);

/**
 * ドローの控え（com.suibari.nagi.cardGet）の索引。
 *
 * レコードは**ユーザー自身の repo** にあるが、**権威ではなく控え**。ドローの結果を決めるのは
 * AppView で、ここに来るのは「引いた」という申告にすぎない。card_draws / card_instances と
 * 突き合わせて一致しないものは索引しない。
 *
 * ユーザーの repo に置く理由は、リアクションの subject（strongRef）が実在の PDS レコードを
 * 要求するから。botたん の repo に置くと通知の宛先が botたん になってしまうが、
 * 本人の repo なら「レコードの持ち主＝宛先」で済む。
 */
export const nagiCardGets = nagiSchema.table(
  "card_gets",
  {
    /** at://did/com.suibari.nagi.cardGet/{drawDate}-{source}。rkey は決定論的。 */
    uri: text("uri").primaryKey(),
    cid: text("cid").notNull(),
    did: text("did").notNull(),
    cardVolume: integer("card_volume").notNull(),
    cardNumber: integer("card_number").notNull(),
    /** JST 4:00 始まりの "YYYY-MM-DD"。card_draws と突き合わせるキー。 */
    drawDate: text("draw_date").notNull(),
    /**
     * "my_nagi" | "reaction" | "anniversary"。
     * card_draws の enum を広げずに text で持つのは、記念日が card_draws を使わないため
     * （既存 enum に値を足すと ALTER TYPE が要る）。
     */
    source: text("source").notNull(),
    /** ニュースの絞り込み（SR以上）に使う。定義から引けるが、SQL で絞りたいので焼き付ける。 */
    rarity: text("rarity").notNull(),
    /**
     * 実際に引いた時刻（card_draws.created_at / card_instances.acquired_at）。**照合済み**。
     * ニュースはこれで並べる。過去ぶんを後から控えても、今日のニュースには出ない。
     */
    drawnAt: timestamp("drawn_at", { withTimezone: true }).notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** 本人がレコードを消したら記録から隠す。所持そのものは card_instances 側が権威。 */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // 同じドローを別の rkey で二重に控えさせない。
    uniqueIndex("nagi_card_gets_draw_idx").on(
      t.did,
      t.drawDate,
      t.source,
      t.cardVolume,
      t.cardNumber,
    ),
    // ニュースタブ（レアリティで絞って実時刻順）。
    index("nagi_card_gets_news_idx").on(t.rarity, t.drawnAt),
    index("nagi_card_gets_owner_idx").on(t.did, t.drawnAt),
  ],
);

/**
 * コンボの初回発見。**誰が最初にその組み合わせを出したか**を1コンボ1行で持つ。
 *
 * コンボは隠し要素で、30枚から3枚は4060通りあるため自力での全探索は現実的でない。
 * 一度誰かが出したら記録に出して伝播させることで「攻略」が成立する。
 * 発見者は後から変わらないので、行は作られたら不変。
 */
export const nagiZenkatsuComboDiscoveries = nagiSchema.table(
  "zenkatsu_combo_discoveries",
  {
    comboVolume: integer("combo_volume").notNull(),
    comboNumber: integer("combo_number").notNull(),
    /** 最初に出した人。 */
    did: text("did").notNull(),
    /** そのときの提出。記録へ飛べるように持つ。 */
    submissionUri: text("submission_uri").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 「最初の1人」なので、コンボごとに1行しか作らせない。
    primaryKey({ columns: [t.comboVolume, t.comboNumber] }),
    index("nagi_zenkatsu_combo_discoveries_did_idx").on(t.did, t.discoveredAt),
  ],
);

/**
 * ゼンカツ！のトロフィー。部長賞だけを翌朝確定し、ほかは提出時に付与する。
 * kind は旧データと同じ値を使い、廃止した賞の履歴も読めるようにする。
 */
export const nagiZenkatsuTrophies = nagiSchema.table(
  "zenkatsu_trophies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 対象の日（前日ぶん）。 */
    themeDate: text("theme_date").notNull(),
    did: text("did").notNull(),
    /**
     * 賞の種類。'bottan' は「今日のナギカツ部長」。
     * 文字列で持つのは、賞を足すたびに enum の ALTER を挟みたくないため。
     */
    kind: text("kind").notNull(),
    submissionUri: text("submission_uri").notNull(),
    /** 今日のナギカツ部長に選んだ理由のひとこと。 */
    commentJa: text("comment_ja"),
    commentEn: text("comment_en"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 部長賞だけは1日1人。再試行で選出が変わっても1人に収束する。
    uniqueIndex("nagi_zenkatsu_trophies_bottan_day_idx")
      .on(t.themeDate)
      .where(sql`${t.kind} = 'bottan'`),
    // 同じ日・同じ賞・同じ人は1回まで（ジョブの再実行でも増えない）。
    uniqueIndex("nagi_zenkatsu_trophies_day_kind_did_idx").on(
      t.themeDate,
      t.kind,
      t.did,
    ),
    index("nagi_zenkatsu_trophies_owner_idx").on(t.did, t.createdAt),
  ],
);

/** 日次の部長賞確定ジョブ。1日1件で、二重確定を主キーで防ぐ。 */
export const nagiZenkatsuAwardJobs = nagiSchema.table(
  "zenkatsu_award_jobs",
  {
    themeDate: text("theme_date").primaryKey(),
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
  (t) => [index("nagi_zenkatsu_award_jobs_ready_idx").on(t.state, t.nextAttemptAt)],
);

/**
 * 自分年表（Chronicle）のうち、**LLM が書いたものだけ**を持つ。
 *
 * 記念日カード・「はじめて」の記録・Nagi にやってきた日・botたんと出会った日・
 * 本人が反応したニュースは、ここには入れない。あれらは card_instances / diaries /
 * profiles / followers / reactions / bookmarks が権威で、コピーを作ると
 * 「カードを交換して owner_did が動いた」「過去の日記をバックフィルして MIN が動いた」
 * ときに年表だけが古い事実を表示し続ける。getChronicle が読み取り時に合流させる。
 *
 * 逆に LLM の出力だけは再現不可能でコストも乗るので、必ず行にする。
 *
 * **月ごと丸ごと置換できる形にしてある。** dedupe_key は月内で閉じた鍵
 * （'llm:2026-08:0' / 'news:2026-08'）で、書き終わりに source_month が同じで
 * 今回の鍵に無い行を消す。UNIQUE だけだと「前回3件・今回1件」で余りが残る。
 */
export const nagiChronicleEvents = nagiSchema.table(
  "chronicle_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectDid: text("subject_did").notNull(),
    /**
     * 年表に並ぶ日付。ユーザーのローカル日付 "YYYY-MM-DD"。
     * diaries.diary_date と同じく text で持つ（AGENTS.md の Date 補間問題を避ける方針）。
     */
    eventDate: text("event_date").notNull(),
    /**
     * 'highlight'（日記から抜いた大きな出来事）/ 'news_context'（そのころ世の中では）。
     * enum にしないのは、種別を足すたびに ALTER TYPE を挟みたくないため
     * （card_gets.source と同じ割り切り）。将来ゼンカツのトロフィーを足すのもこれで済む。
     */
    kind: text("kind").notNull(),
    /** どの月のロールアップが作ったか。"YYYY-MM"。 */
    sourceMonth: text("source_month").notNull(),
    /** 月内で閉じた置換キー。 */
    dedupeKey: text("dedupe_key").notNull(),
    titleJa: text("title_ja").notNull(),
    titleEn: text("title_en").notNull(),
    detailJa: text("detail_ja"),
    detailEn: text("detail_en"),
    /**
     * 選んだ日記から一字も変えずに抜いた12字以上の逐語抜粋。**表示しない。**
     * 取り込み時に diary.includes(evidence) を検証して幻覚を落とすためのもので、
     * 行に残すのは後からプロンプトを変えたときに突き合わせられるようにするため。
     */
    evidence: text("evidence"),
    /** highlight の由来。UI は /diary?date= へ飛ばす。 */
    diaryUri: text("diary_uri"),
    /** news_context の由来。 */
    newsUri: text("news_uri"),
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
    // 同じ月を作り直しても増えない。
    uniqueIndex("nagi_chronicle_events_dedupe_idx").on(t.subjectDid, t.dedupeKey),
    // 年表は年チャンクで引く。
    index("nagi_chronicle_events_timeline_idx").on(t.subjectDid, t.eventDate),
    // 月ごとの置換（source_month で消す）が乗る。
    index("nagi_chronicle_events_month_idx").on(t.subjectDid, t.sourceMonth),
  ],
);

/**
 * 月次ロールアップのリースキュー（zenkatsu_comment_jobs と同型）。
 *
 * 「日記はあるが chronicle_events が無い (did, month)」を毎 tick 導出する方式にしないのは、
 * **失敗の記憶が無い**から。常に失敗する月ができると、それを毎分 Ollama へ投げ続ける。
 *
 * diary_count はエンキュー時点の日記件数。現在件数と食い違ったら pending へ戻して
 * 月ごと作り直す（遅れて入った日記の回収を、タイムゾーンの厳密計算ではなく
 * 「再実行が安全であること」で担保する）。
 */
export const nagiChronicleJobs = nagiSchema.table(
  "chronicle_jobs",
  {
    subjectDid: text("subject_did").notNull(),
    /** 対象月。"YYYY-MM"。 */
    month: text("month").notNull(),
    diaryCount: integer("diary_count").notNull(),
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
    primaryKey({ columns: [t.subjectDid, t.month] }),
    index("nagi_chronicle_jobs_ready_idx").on(t.state, t.nextAttemptAt),
  ],
);

/**
 * 年表の「そのころ世の中では」。**月ごとに1行で、全ユーザー共通。**
 *
 * 利用者ごとに持たない。これは「その月に世の中で何があったか」であって、その人に
 * 関係のある話ではないので、同じ事実を人数分複製する理由が無い。LLM の呼び出しも
 * 【人数 × 月】ではなく【月】だけで済む。
 *
 * **この表そのものがジョブでもある。** 月は高々12行/年しか増えないので、別のジョブ表を
 * 立てずに state と再試行をここに持たせている。
 * `news_uri` が NULL のまま state='posted' なら「その月は選ばなかった」＝正常。
 *
 * **見出しは持たない。** 年表には記事の原題をそのまま出すので、ここが持つのは
 * 「どれを選んだか」だけ。botたんの言い換えを焼き付けると、記事が編集されたときに
 * ずれるし、言い換えの揺れや字数超過の問題も抱え込むことになる。
 */
export const nagiChronicleNews = nagiSchema.table(
  "chronicle_news",
  {
    /** 対象月。"YYYY-MM"。 */
    month: text("month").primaryKey(),
    /** 選んだニュース。NULL は「選ばなかった」。 */
    newsUri: text("news_uri"),
    /** 候補に出した件数。あとから「選択肢が薄かった月」を見分けられるように残す。 */
    candidateCount: integer("candidate_count").default(0).notNull(),
    state: botJobState("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
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
  (t) => [index("nagi_chronicle_news_ready_idx").on(t.state, t.nextAttemptAt)],
);
