/**
 * おすすめフィードに何が並ぶかを確認する。本番DBに向けても書き込まないよう、
 * 読み取り専用の接続でなければ止まる。
 *   DATABASE_URL='postgres://…?default_transaction_read_only=on' \
 *     pnpm tsx scripts/previewRecommended.ts <handle|did|guest> [件数]
 */
import { client, db } from "@bsky-affirmative-bot/database";
import { sql } from "drizzle-orm";
import {
  getRecommended,
  MIN_RECOMMEND_REACTORS,
  resolveInterestSource,
} from "../src/queries/recommended.js";

const [readOnly] = await client`show default_transaction_read_only`;
if (readOnly?.default_transaction_read_only !== "on") {
  await client.end();
  throw new Error("DATABASE_URL に ?default_transaction_read_only=on を付けてください");
}

const [who = "guest", count = "30"] = process.argv.slice(2);
let viewerDid: string | undefined;
if (who !== "guest") {
  const rows = await db.execute<{ did: string }>(
    sql`select did from nagi.actors where did = ${who} or handle = ${who} limit 1`,
  );
  viewerDid = rows[0]?.did;
  if (!viewerDid) throw new Error(`actor not found: ${who}`);
}
const started = performance.now();
const page = await getRecommended({ limit: Number(count), viewerDid });
const elapsed = Math.round(performance.now() - started);
console.log(`viewer=${viewerDid ?? "guest"} source=${await resolveInterestSource(viewerDid)} items=${page.items.length} ${elapsed}ms`);
// 入った理由を見るための値。開発用の出力で、画面には出さない。
const uris = page.items.map((item) => item.uri);
const probeSql =
  viewerDid
    ? sql`(select min(probe.embedding <=> p.embedding) from (
        (select embedding from nagi.posts where did = ${viewerDid} and deleted_at is null and embedding is not null
          order by indexed_at desc limit 10)
        union all
        (select embedding from nagi.actor_interest_probes where did = ${viewerDid} limit 10)) probe)`
    : sql`null::float8`;
const reasons = uris.length
  ? await db.execute<{ uri: string; reactors: number; distance: number | null }>(sql`
      select p.uri,
             (select count(distinct r.did)::int from nagi.reactions r
               where r.subject_uri = p.uri and r.did <> p.did and r.did <> ${process.env.NAGI_BOT_DID ?? ""}) as reactors,
             ${probeSql} as distance
        from nagi.posts p where p.uri in ${sql`(${sql.join(uris.map((u) => sql`${u}`), sql`, `)})`}`)
  : [];
const byUri = new Map(reasons.map((row) => [row.uri, row]));
for (const item of page.items) {
  const text = item.text.replace(/\s+/g, " ").slice(0, 50);
  const reason = byUri.get(item.uri);
  const why = [
    reason && reason.reactors >= MIN_RECOMMEND_REACTORS ? `反応${reason.reactors}人` : "",
    reason?.distance != null && Number(reason.distance) <= 0.5 ? `興味${Number(reason.distance).toFixed(2)}` : "",
  ].filter(Boolean).join(" ");
  console.log(`${item.indexedAt.slice(0, 16)}  [${why}]  @${item.author.handle}  ${text}`);
}
await client.end();
