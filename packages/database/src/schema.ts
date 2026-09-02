import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  serial,
  pgSchema,
  customType,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
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

export const affirmativeBotSchema = pgSchema("affirmative_bot");

export const followers = affirmativeBotSchema.table("followers", {
  did: text("did").primaryKey(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  is_u18: integer("is_u18").default(0),
  is_ai_only: integer("is_ai_only").default(0),
  last_uranai_at: timestamp("last_uranai_at"),
  reply_freq: integer("reply_freq").default(100),
  last_conv_at: timestamp("last_conv_at"),
  conv_history: jsonb("conv_history"),
  conv_root_cid: text("conv_root_cid"),
  last_analyze_at: timestamp("last_analyze_at"),
  last_cheer_at: timestamp("last_cheer_at"),
  last_dj_at: timestamp("last_dj_at"),
  user_anniv_name: text("user_anniv_name"),
  user_anniv_date: text("user_anniv_date"),
  last_anniv_execed_at: timestamp("last_anniv_execed_at"),
  last_anniv_registered_at: timestamp("last_anniv_registered_at"),
  last_status_at: timestamp("last_status_at"),
  question_root_uri: text("question_root_uri"),
  last_answered_at: timestamp("last_answered_at"),
  last_recap_at: timestamp("last_recap_at"),
  is_diary: integer("is_diary").default(0),
  // 日記を書き終えたユーザーのローカル日付 "YYYY-MM-DD"。
  // 二重投稿の防止と、22時を過ぎた取りこぼしの回収判定に使う。
  last_diary_date: text("last_diary_date"),
  is_anniv: integer("is_anniv").default(1),
  last_whimsical_responded_uri: text("last_whimsical_responded_uri"),
  positivity_level: integer("positivity_level").default(0),
  current_title_ja: text("current_title_ja"),
  current_title_en: text("current_title_en"),
  last_room_visit_at: timestamp("last_room_visit_at"),
  room_invite_sent: integer("room_invite_sent").default(0),
  room_badge_pending: integer("room_badge_pending").default(0),
  regular_level: integer("regular_level").default(0),
  last_regular_badge_at: timestamp("last_regular_badge_at"),
  room_interaction_count: integer("room_interaction_count").default(0),
});

export const posts = affirmativeBotSchema.table("posts", {
  did:        text("did").primaryKey(),
  post:       text("post"),
  score:      integer("score"),
  updated_at: timestamp("updated_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  uri:        text("uri"),
  comment:    text("comment"),
  embedding:  vector("embedding", { dimensions: 1024 }),
});

export const likes = affirmativeBotSchema.table("likes", {
  did: text("did").primaryKey(),
  liked_post: text("liked_post"),
  uri: text("uri"),
  updated_at: timestamp("updated_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const replies = affirmativeBotSchema.table("replies", {
  did: text("did").primaryKey(),
  reply: text("reply"),
  uri: text("uri"),
  isRead: integer("isRead").default(0),
  updated_at: timestamp("updated_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const bot_state = affirmativeBotSchema.table("bot_state", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const affirmations = affirmativeBotSchema.table("affirmations", {
  id: serial("id").primaryKey(),
  did: text("did"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const interaction = affirmativeBotSchema.table("interaction", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  did: text("did"),
  details: jsonb("details"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const subscribers = affirmativeBotSchema.table("subscribers", {
  id: serial("id").primaryKey(),
  discord_id: text("discord_id").unique(), // Can be null initially for Google Sheet legacy imports
  did: text("did").unique().notNull(),
  status: text("status").default("active").notNull(), // 'active' | 'inactive' | 'discord_only'
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const biorhythm_history = affirmativeBotSchema.table("biorhythm_history", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(),
  mood: text("mood").notNull(),
  mood_en: text("mood_en"),
  energy: integer("energy").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Bluesky / Nagi / biorhythm / YouTube を横断する、botたんの内部記憶。
 *
 * ユーザー入力はすべて untrusted data として扱う。Nagi の kossori / channelOnly は
 * この表へ入れず、公開範囲を後段の検索だけに委ねない。
 */
export const bot_memory_documents = affirmativeBotSchema.table(
  "bot_memory_documents",
  {
    id: serial("id").primaryKey(),
    source_type: text("source_type").notNull(),
    source_id: text("source_id").notNull(),
    source_uri: text("source_uri"),
    author_id: text("author_id"),
    content: text("content").notNull(),
    bot_response: text("bot_response"),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    affirmation_score: integer("affirmation_score"),
    metadata: jsonb("metadata"),
    content_hash: text("content_hash").notNull(),
    embedding_model: text("embedding_model"),
    embedding: vector("embedding", { dimensions: 1024 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bot_memory_source_key_idx").on(table.source_type, table.source_id),
    index("bot_memory_source_occurred_idx").on(table.source_type, table.occurred_at),
    index("bot_memory_author_occurred_idx").on(table.author_id, table.occurred_at),
    index("bot_memory_pending_embedding_idx")
      .on(table.embedding_model, table.updated_at)
      .where(sql`${table.deleted_at} is null and ${table.embedding} is null`),
    index("bot_memory_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("bot_memory_content_trgm_idx").using("gin", table.content.op("gin_trgm_ops")),
  ],
);

/** 公開会話から抽出した、daily plan へ再利用できる作品名・印象語。 */
export const bot_memory_impressions = affirmativeBotSchema.table(
  "bot_memory_impressions",
  {
    id: serial("id").primaryKey(),
    document_id: integer("document_id")
      .notNull()
      .references(() => bot_memory_documents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    relation: text("relation").notNull(),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("bot_memory_impression_kind_check", sql`${table.kind} in ('work', 'word')`),
    check(
      "bot_memory_impression_relation_check",
      sql`${table.relation} in ('recommended', 'liked', 'discussed')`,
    ),
    uniqueIndex("bot_memory_impression_document_label_idx").on(
      table.document_id,
      table.label,
    ),
    index("bot_memory_impression_last_used_idx").on(table.last_used_at),
  ],
);

/** 何も抽出されなかった文書も再走査し続けないための本文ハッシュ単位の完了印。 */
export const bot_memory_impression_scans = affirmativeBotSchema.table(
  "bot_memory_impression_scans",
  {
    document_id: integer("document_id")
      .primaryKey()
      .references(() => bot_memory_documents.id, { onDelete: "cascade" }),
    content_hash: text("content_hash").notNull(),
    scanned_at: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

/** RAGで知った作品名・固有名詞を、表示本文を変えずに読み上げるための発話表記。 */
export const bot_memory_pronunciations = affirmativeBotSchema.table(
  "bot_memory_pronunciations",
  {
    surface: text("surface").primaryKey(),
    spoken_form: text("spoken_form"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    origin: text("origin").notNull(),
    evidence_count: integer("evidence_count").default(1).notNull(),
    conflict_count: integer("conflict_count").default(0).notNull(),
    first_seen_at: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("bot_memory_pronunciation_kind_check", sql`${table.kind} in ('work', 'proper_noun')`),
    check("bot_memory_pronunciation_status_check", sql`${table.status} in ('active', 'ignored', 'disabled')`),
    check("bot_memory_pronunciation_origin_check", sql`${table.origin} in ('auto', 'manual')`),
    check(
      "bot_memory_pronunciation_spoken_form_check",
      sql`(${table.status} = 'active' and ${table.spoken_form} is not null) or (${table.status} = 'ignored' and ${table.spoken_form} is null) or ${table.status} = 'disabled'`,
    ),
    index("bot_memory_pronunciation_status_idx").on(table.status, table.updated_at),
  ],
);

/** 同じ印象行を何度もLLMへ送らないための完了印。 */
export const bot_memory_pronunciation_scans = affirmativeBotSchema.table(
  "bot_memory_pronunciation_scans",
  {
    impression_id: integer("impression_id")
      .primaryKey()
      .references(() => bot_memory_impressions.id, { onDelete: "cascade" }),
    scanned_at: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

/** RAG が実際に採用した記憶。単なる検索候補は記録しない。 */
export const bot_memory_usages = affirmativeBotSchema.table(
  "bot_memory_usages",
  {
    id: serial("id").primaryKey(),
    document_id: integer("document_id")
      .notNull()
      .references(() => bot_memory_documents.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    output_ref: text("output_ref"),
    used_at: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("bot_memory_usage_document_used_idx").on(table.document_id, table.used_at),
    index("bot_memory_usage_purpose_used_idx").on(table.purpose, table.used_at),
  ],
);

/**
 * bot-tan.com のダッシュボードが描く推移の元データ。
 *
 * 日次カウンタは resetDailyStats() で毎晩ゼロに戻ってしまうので、消える直前の
 * 確定値をここに1行だけ残す。指標が増えるたびに列を足す（= マイグレーションする）
 * ことになるのを避けるため、値は jsonb 1つにまとめている。
 */
export const daily_metrics = affirmativeBotSchema.table("daily_metrics", {
  /** リセット時点の JST 日付 "YYYY-MM-DD"。 */
  date: text("date").primaryKey(),
  /** { bsky: {...}, nagi: {...}, common: {...} } */
  metrics: jsonb("metrics").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/**
 * botたんのDIDに対してPDSが受理したrepo書き込み。
 *
 * 日次カウンタでは1時間/24時間のローリング窓を正しく復元できず、並行更新でも
 * 取りこぼすため、成功した操作を追記専用で残す。
 */
export const repo_write_points = affirmativeBotSchema.table(
  "repo_write_points",
  {
    id: serial("id").primaryKey(),
    did: text("did").notNull(),
    action: text("action").notNull(),
    points: integer("points").notNull(),
    source: text("source").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("repo_write_points_did_created_idx").on(table.did, table.created_at)],
);

export const gifts = affirmativeBotSchema.table("gifts", {
  id: serial("id").primaryKey(),
  did: text("did").notNull(),
  content: text("content").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  status: text("status").default("new").notNull(),
  // "new": 未言及, "introduced": 新着紹介済み, "used": 使用報告済み（再選択あり）
  // updated_at から3日経過で再使用可能
});

/**
 * お部屋で起きたできごと。
 *
 * biorhythm_server が未読を読んで status_text（いま何をしているか）の生成材料にし、既読にする。
 * エネルギー加算は followers.room_interaction_count が担当していて、こちらは描写専用。
 * 表示名は読み出し時に did から解決するので持たない（改名に追随させるため）。
 */
export const room_events = affirmativeBotSchema.table(
  "room_events",
  {
    id: serial("id").primaryKey(),
    did: text("did").notNull(),
    /** "gift" | "chat" | "greeting" */
    type: text("type").notNull(),
    /** プレゼント内容・会話の話題など。ユーザー入力なので下流では必ずデータとして扱う */
    detail: text("detail"),
    is_read: integer("is_read").default(0).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("room_events_unread_idx").on(table.is_read, table.created_at)],
);

export const youtube_shorts = affirmativeBotSchema.table("youtube_shorts", {
  id: serial("id").primaryKey(),
  url: text("url").notNull().unique(),
  title: text("title"),
  status: text("status").default("new").notNull(),
  // "new": 未告知, "posted": 告知済み
  corners: jsonb("corners"),
  // corners format:
  // [
  //   { "corner_name": "SelfAffirmationCorner", "status": "Sleep" },
  //   { "corner_name": "BlueskyCorner", "theme": "LGBTQ" }
  // ]
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * リサーチ待ちのリースキュー。
 *
 * **nagi ではなく記憶側（affirmative_bot の bot_memory_* 群）に置く。** 積まれるのは
 * 「botたんが遭遇してまだ知らない対象」で、入口は Bluesky・Nagi のリプライと、記憶から
 * 抽出された印象ラベル（YouTube 配信のコメント由来を含む）。出口は bot_memory_documents
 * で、これも全サーフェス共通。どの表面にも属さない。
 *
 * 積まれるのは投稿本文ではなく、返信を書いたモデルが「知らなかった」と申告した語、
 * または印象ラベル。利用者が投稿に貼った URL は返信時の同期グラウンディングで読むため、
 * このキューには入れない。
 *
 * 主キーは正規化した対象のハッシュ。同じものが何度流れてきても二重に調べない
 * （ON CONFLICT DO NOTHING でエンキューする）。
 */
export const bot_memory_research_jobs = affirmativeBotSchema.table(
  "bot_memory_research_jobs",
  {
    subject_hash: text("subject_hash").primaryKey(),
    subject: text("subject").notNull(),
    // nagi の bot_job_state と同型だが、スキーマを跨いで enum を共有できないので
    // ここでは text + check にする。値は pending / processing / posted / failed。
    state: text("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("bot_memory_research_jobs_ready_idx").on(table.state, table.next_attempt_at),
    check(
      "bot_memory_research_jobs_state_check",
      sql`${table.state} in ('pending', 'processing', 'posted', 'failed')`,
    ),
  ],
);
