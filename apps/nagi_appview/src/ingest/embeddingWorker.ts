import {
  createEmbeddingRetryBackoff,
  db,
  generateEmbeddings,
  isEmbeddingAvailable,
  nagiActorAnalyses,
  nagiChannels,
  nagiNews,
  nagiNewsApprovals,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

// 一度に埋め込む件数。Ollama へのバッチ入力サイズ兼 DB 更新単位。
const BATCH_SIZE = 16;
// 未処理が残っていれば速く回し、空振りしたら間隔を空ける（バックフィルと定常の両対応）。
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 30_000;

let running = false;
// 失敗した行を選び直し続けないための記録。詳細は embeddingRetryBackoff.ts。
const backoff = createEmbeddingRetryBackoff();

/** 埋め込む1件。`text` を埋め込み、`save` で（同時編集をガードしつつ）永続化する。 */
type Pending = {
  /** 失敗の記録に使う識別子。エンティティをまたいで一意（`posts:<uri>` など）。 */
  key: string;
  text: string;
  /** 埋め込みを書き込む。同時編集で対象が変わっていたら false（NULL のまま再処理させる）。 */
  save(embedding: number[]): Promise<boolean>;
};

/** 埋め込み対象エンティティ。優先順（配列順）に未処理を探して処理する。 */
type EmbedSource = {
  name: string;
  fetchBatch(limit: number): Promise<Pending[]>;
};

const sources: EmbedSource[] = [
  {
    name: "posts",
    async fetchBatch(limit) {
      const rows = await db
        .select({ uri: nagiPosts.uri, text: nagiPosts.text })
        .from(nagiPosts)
        .where(and(isNull(nagiPosts.embedding), isNull(nagiPosts.deletedAt)))
        .orderBy(desc(nagiPosts.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        key: `posts:${r.uri}`,
        text: r.text,
        async save(embedding) {
          const w = await db
            .update(nagiPosts)
            .set({ embedding })
            .where(and(eq(nagiPosts.uri, r.uri), eq(nagiPosts.text, r.text)))
            .returning({ uri: nagiPosts.uri });
          return w.length > 0;
        },
      }));
    },
  },
  {
    name: "profiles",
    async fetchBatch(limit) {
      // botたん分析(analysisJa)があれば連結して人物ベクトルを濃くする。
      const rows = await db
        .select({
          did: nagiProfiles.did,
          displayName: nagiProfiles.displayName,
          description: nagiProfiles.description,
          analysisJa: nagiActorAnalyses.analysisJa,
        })
        .from(nagiProfiles)
        .leftJoin(nagiActorAnalyses, eq(nagiActorAnalyses.did, nagiProfiles.did))
        .where(isNull(nagiProfiles.embedding))
        .orderBy(desc(nagiProfiles.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        key: `profiles:${r.did}`,
        text: [r.displayName, r.description, r.analysisJa]
          .filter(Boolean)
          .join("\n"),
        async save(embedding) {
          const w = await db
            .update(nagiProfiles)
            .set({ embedding })
            // 同一表フィールドの一致でガード（analysisJa 更新は別途 NULL リセットされる）。
            .where(
              and(
                eq(nagiProfiles.did, r.did),
                eq(nagiProfiles.displayName, r.displayName),
                sql`${nagiProfiles.description} is not distinct from ${r.description}`,
              ),
            )
            .returning({ did: nagiProfiles.did });
          return w.length > 0;
        },
      }));
    },
  },
  {
    name: "channels",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiChannels.uri,
          name: nagiChannels.name,
          description: nagiChannels.description,
        })
        .from(nagiChannels)
        .where(and(isNull(nagiChannels.embedding), isNull(nagiChannels.deletedAt)))
        .orderBy(desc(nagiChannels.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        key: `channels:${r.uri}`,
        text: [r.name, r.description].filter(Boolean).join("\n"),
        async save(embedding) {
          const w = await db
            .update(nagiChannels)
            .set({ embedding })
            .where(
              and(
                eq(nagiChannels.uri, r.uri),
                eq(nagiChannels.name, r.name),
                sql`${nagiChannels.description} is not distinct from ${r.description}`,
              ),
            )
            .returning({ uri: nagiChannels.uri });
          return w.length > 0;
        },
      }));
    },
  },
  {
    name: "news",
    async fetchBatch(limit) {
      const rows = await db
        .select({
          uri: nagiNews.uri,
          cid: nagiNews.cid,
          titleJa: nagiNewsApprovals.snapshotTitleJa,
          sourceName: nagiNewsApprovals.snapshotSourceName,
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
            isNull(nagiNews.embedding),
            isNull(nagiNews.deletedAt),
            eq(nagiNewsApprovals.status, "approved"),
          ),
        )
        .orderBy(desc(nagiNews.indexedAt))
        .limit(limit);
      return rows.map((r) => ({
        key: `news:${r.uri}`,
        text: [r.titleJa, r.sourceName].filter(Boolean).join("\n"),
        async save(embedding) {
          const w = await db
            .update(nagiNews)
            .set({ embedding })
            .where(and(eq(nagiNews.uri, r.uri), eq(nagiNews.cid, r.cid)))
            .returning({ uri: nagiNews.uri });
          return w.length > 0;
        },
      }));
    },
  },
];

/**
 * NL検索(意味検索)用の埋め込みを非同期生成するワーカー。
 *
 * ジョブ表は持たず、各エンティティの `embedding IS NULL`（+未削除）をスキャンする方式。
 * これで「新規（NULL）」「既存バックフィル（NULL）」「編集で NULL リセットされた行」の
 * すべてが同じ経路で処理される。ingest のトランザクション内では Ollama を呼ばない
 * （ロックを長持ちさせないため）ので、本ワーカーが tx 外で肩代わりする。
 *
 * OLLAMA_BASE_URL 未設定なら generateEmbeddings が null を返すだけなので実質 no-op。
 */
export function startEmbeddingWorker() {
  if (running) return;
  running = true;

  // 優先順に、未処理のある最初のエンティティを1バッチ処理する。
  const tick = async (): Promise<number> => {
    // cooldown 中に選ぶと、送っていない行まで失敗として記録してしまう。
    if (!isEmbeddingAvailable({ background: true })) return 0;
    for (const source of sources) {
      // 待たせている行で枠が埋まらないよう、その分だけ多めに取る。
      const pending = (await source.fetchBatch(BATCH_SIZE + backoff.size()))
        .filter((p) => !backoff.blocked(p.key))
        .slice(0, BATCH_SIZE);
      if (!pending.length) continue;

      const embeddings = await generateEmbeddings(
        pending.map((p) => p.text),
        { background: true },
      );
      let updated = 0;
      for (let i = 0; i < pending.length; i++) {
        const embedding = embeddings[i];
        if (!embedding) {
          // Ollama 失敗/未設定。しばらく待たせて、後ろの行を先に進める。
          backoff.fail(pending[i].key);
          continue;
        }
        backoff.succeed(pending[i].key);
        if (await pending[i].save(embedding)) updated++;
      }
      return updated;
    }
    return 0;
  };

  const loop = async () => {
    let processed = 0;
    try {
      processed = await tick();
    } catch (e) {
      console.error("[ERROR][embeddingWorker]", e);
    }
    setTimeout(
      () => void loop(),
      processed > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
    );
  };

  void loop();
}
