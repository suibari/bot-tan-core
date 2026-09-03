import { db, nagiActors, nagiProfiles } from "@bsky-affirmative-bot/database";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import {
  embedQuery,
  relativeCut,
  SEMANTIC_LIMIT,
  semanticConditions,
  type SearchMode,
} from "./hybridSearch.js";
import { ApiError } from "../middleware/errors.js";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

// これより短いクエリは意味検索をかけない（タイプアヘッドのノイズとレイテンシを避け、
// 従来の handle/displayName prefix 挙動をそのまま維持する）。
const MIN_SEMANTIC_LEN = 3;

/** getProfile の actor は AT Protocol の慣例どおり DID と handle の両方を受け付ける。 */
export async function resolveActorDid(rawActor: string): Promise<string> {
  const actor = rawActor.trim().replace(/^@/, "");
  if (actor.startsWith("did:")) return actor;
  const [row] = await db
    .select({ did: nagiActors.did })
    .from(nagiActors)
    .where(
      and(
        eq(nagiActors.status, "active"),
        eq(sql<string>`lower(${nagiActors.handle})`, actor.toLowerCase()),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", "Actor not found");
  return row.did;
}

// プロフィール埋め込み(displayName+description+分析)は短文で距離が出やすいので、投稿より緩めの
// しきい値を既定にする。env で調整可能。
// hybridSearch.ts の SEM_DIST_MAX と同じ注意: OLLAMA_QUERY_PREFIX を入れると距離スケールが
// 約 +0.19 上がるので、接頭辞を有効にするならここも一緒に上げること（0.8 → 0.95）。
// この値自体に関連/無関連の選別能力はなく、実際に効いているのは relativeCut と SEMANTIC_LIMIT。
const ACTOR_SEM_DIST_MAX = (() => {
  const v = Number(process.env.SEARCH_ACTOR_SEM_DIST_MAX);
  return Number.isFinite(v) && v > 0 ? v : 0.8;
})();

const actorView = ({
  actor,
  profile,
}: {
  actor: typeof nagiActors.$inferSelect;
  profile: typeof nagiProfiles.$inferSelect;
}) => ({
  did: actor.did,
  handle: actor.handle,
  displayName: profile.displayName,
  avatar: profile.avatarCid
    ? `/api/blob/${encodeURIComponent(actor.did)}/${profile.avatarCid}`
    : undefined,
});

export async function searchActors(
  rawQuery: string,
  limit: number,
  mode: SearchMode = "hybrid",
) {
  const query = rawQuery.trim().replace(/^@/, "").trim().slice(0, 256);
  if (!query) return { actors: [] };
  const escaped = escapeLike(query);
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;
  // handle / displayName にその語が入っているか。exact の条件であり、semantic の除外条件でもある。
  const lexical = or(
    ilike(nagiActors.handle, contains),
    ilike(nagiProfiles.displayName, contains),
  )!;
  const selection = { actor: nagiActors, profile: nagiProfiles };
  const from = () =>
    db
      .select(selection)
      .from(nagiProfiles)
      .innerJoin(nagiActors, eq(nagiActors.did, nagiProfiles.did));

  if (mode === "exact") {
    const rows = await from()
      .where(and(eq(nagiActors.status, "active"), lexical))
      .orderBy(
        // handle 前方一致 → displayName 前方一致 → それ以外の部分一致。
        sql`CASE
          WHEN ${nagiActors.handle} ILIKE ${prefix} THEN 0
          WHEN ${nagiProfiles.displayName} ILIKE ${prefix} THEN 1
          ELSE 2
        END`,
        asc(nagiActors.handle),
      )
      .limit(Math.min(20, Math.max(1, limit)));
    return { actors: rows.map(actorView) };
  }

  // 短すぎるクエリは埋め込みがノイズにしかならないので意味検索をかけない。
  const embedding =
    query.length >= MIN_SEMANTIC_LEN ? await embedQuery(query) : null;

  if (mode === "semantic") {
    const conditions = semanticConditions({
      embedding,
      q: query,
      embeddingCol: nagiProfiles.embedding,
      // 除外は ILIKE 一発ではなく handle/displayName の両方を見る必要があるので、
      // textExpr にはその連結を渡して semanticConditions の not ilike をそのまま効かせる。
      textExpr: sql`coalesce(${nagiActors.handle}, '') || ' ' || coalesce(${nagiProfiles.displayName}, '')`,
      distMax: ACTOR_SEM_DIST_MAX,
    });
    if (!conditions) return { actors: [] };
    const rows = await db
      .select({ ...selection, semDistance: conditions.distance })
      .from(nagiProfiles)
      .innerJoin(nagiActors, eq(nagiActors.did, nagiProfiles.did))
      .where(and(eq(nagiActors.status, "active"), conditions.match))
      .orderBy(conditions.orderBy, asc(nagiActors.handle))
      .limit(SEMANTIC_LIMIT);
    return {
      actors: relativeCut(rows, (row) => Number(row.semDistance)).map(actorView),
    };
  }

  // hybrid（既定・タイプアヘッド互換）: 語彙一致と意味近傍を1本にまとめた従来の挙動。
  const vec = embedding ? sql`${`[${embedding.join(",")}]`}::vector` : null;
  const semMatch = vec
    ? sql`(${nagiProfiles.embedding} is not null and (${nagiProfiles.embedding} <=> ${vec}) < ${ACTOR_SEM_DIST_MAX})`
    : sql`false`;
  const rows = await from()
    .where(and(eq(nagiActors.status, "active"), or(lexical, semMatch)))
    .orderBy(
      // タイプアヘッド優先: handle 前方一致 → displayName 前方一致 → それ以外。
      sql`CASE
        WHEN ${nagiActors.handle} ILIKE ${prefix} THEN 0
        WHEN ${nagiProfiles.displayName} ILIKE ${prefix} THEN 1
        ELSE 2
      END`,
      // 前方一致しない層は意味的に近い順（embedding があるときのみ）。
      ...(vec ? [sql`(${nagiProfiles.embedding} <=> ${vec}) asc nulls last`] : []),
      asc(nagiActors.handle),
    )
    .limit(Math.min(10, Math.max(1, limit)));
  return { actors: rows.map(actorView) };
}
