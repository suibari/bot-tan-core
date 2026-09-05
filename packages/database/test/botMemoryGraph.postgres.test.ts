import assert from "node:assert/strict";
import test, { after } from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.BOT_MEMORY_TEST_DATABASE_URL;

/**
 * db.ts は import 時に DATABASE_URL を読むので、テストより先に差し替える。
 *
 * なお **postgres テストは直列に走らせること**（package.json の test は
 * `--test-concurrency=1`）。node:test は既定でファイルを並列実行するが、
 * このファイルと botMemory.postgres.test.ts は同じ1つのDBを truncate し合うので、
 * 並列だと互いの fixture を消して落ちる。
 * 接続は**ファイル全体で1つ**にして after で閉じる。テストごとに client.end() を
 * 呼ぶと、2件目以降が閉じた接続を掴む（モジュールキャッシュは共有される）。
 */
if (databaseUrl) {
  assert.equal(new URL(databaseUrl).pathname, "/bot_memory_phase1_test");
  process.env.DATABASE_URL = databaseUrl;
}

const setup = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null;
const database = databaseUrl ? await import("@bsky-affirmative-bot/database") : null;

after(async () => {
  await database?.client.end();
  await setup?.end();
});

/** 印象語1つと、共起の相手を1つ持つ公開会話を1件仕込む。 */
async function insertMemory(options: {
  sourceId: string;
  content: string;
  visibility: "public" | "kossori";
  label: string;
  /** 抽出後に本文が書き換わった状態を作る。 */
  staleScan?: boolean;
  deleted?: boolean;
  companionLabel?: string;
  embedding?: string;
}) {
  const hash = `hash-${options.sourceId}`;
  const [document] = await setup!`
    insert into affirmative_bot.bot_memory_documents
      (source_type, source_id, content, visibility, salience, occurred_at, content_hash,
       embedding_model, embedding)
    values ('bsky_received_reply', ${options.sourceId}, ${options.content}, ${options.visibility},
            80, now(), ${hash}, ${options.embedding ? "test-embed" : null},
            ${options.embedding ?? null}::vector)
    returning id`;
  const id = document!.id as number;

  await setup!`insert into affirmative_bot.bot_memory_impressions
    (document_id, kind, label, relation) values (${id}, 'work', ${options.label}, 'liked')`;
  if (options.companionLabel) {
    await setup!`insert into affirmative_bot.bot_memory_impressions
      (document_id, kind, label, relation)
      values (${id}, 'word', ${options.companionLabel}, 'discussed')`;
  }
  await setup!`insert into affirmative_bot.bot_memory_impression_scans
    (document_id, content_hash) values (${id}, ${options.staleScan ? `${hash}-old` : hash})`;
  if (options.deleted) {
    await setup!`update affirmative_bot.bot_memory_documents set deleted_at = now() where id = ${id}`;
  }
}

/**
 * 公開契約そのもののテスト。
 *
 * botMemoryGraph は bot-tan.com の公開ページが読む。こっそり・削除済み・抽出後に
 * 本文が変わった記憶が、ノードにも共起エッジにも1件も寄与しないことを確かめる。
 * 純関数側のテスト（botMemoryGraph.test.ts）はこの層を通らないので、SQL の
 * where 句が緩んだことに気づけるのはここだけ。
 */
test("memory graph never leaks kossori, deleted, or stale-hash memories", {
  skip: !databaseUrl,
}, async () => {
  await setup!`truncate affirmative_bot.bot_memory_documents restart identity cascade`;
  await setup!`truncate affirmative_bot.bot_memory_pronunciations`;

  for (const [sourceId, label] of [["pub-1", "艦これ"], ["pub-2", "艦これ"], ["pub-3", "提督"], ["pub-4", "提督"]] as const) {
    await insertMemory({
      sourceId,
      content: `公開の会話 ${sourceId}`,
      visibility: "public",
      label,
      companionLabel: `${label}のはなし`,
    });
  }
  for (const sourceId of ["kossori-1", "kossori-2"]) {
    await insertMemory({ sourceId, content: `こっそりの会話 ${sourceId}`, visibility: "kossori", label: "内緒の話" });
  }
  for (const sourceId of ["deleted-1", "deleted-2"]) {
    await insertMemory({ sourceId, content: `消した会話 ${sourceId}`, visibility: "public", label: "消えた話", deleted: true });
  }
  for (const sourceId of ["stale-1", "stale-2"]) {
    await insertMemory({ sourceId, content: `編集後の会話 ${sourceId}`, visibility: "public", label: "抽出時の話", staleScan: true });
  }
  // 裏付けが1件しかない = 個人の1会話を復元しうるので出さない
  await insertMemory({ sourceId: "lonely-1", content: "ひとりぼっちの会話", visibility: "public", label: "一度きりの話" });

  const graph = await database!.getBotMemoryGraph();
  const ids = graph.nodes.map((node) => node.id);

  assert.ok(ids.includes("艦これ"));
  assert.ok(ids.includes("提督"));
  for (const forbidden of ["内緒の話", "消えた話", "抽出時の話", "一度きりの話"]) {
    assert.ok(!ids.includes(forbidden), `${forbidden} が公開グラフに出た`);
  }

  // エッジの端点も同じ集合に閉じている
  const known = new Set(ids);
  for (const edge of graph.edges) {
    assert.ok(known.has(edge.source) && known.has(edge.target));
  }
  assert.ok(
    graph.edges.some((edge) =>
      edge.type === "cooccurrence" && [edge.source, edge.target].sort().join("/") === "艦これ/艦これのはなし"
    ),
    "同じ会話に出た語が共起で繋がっていない",
  );

  // 本文や識別子がペイロードのどこにも現れない
  const serialized = JSON.stringify(graph);
  for (const leak of ["公開の会話", "こっそりの会話", "bsky_received_reply", "content_hash", "documentId"]) {
    assert.ok(!serialized.includes(leak), `${leak} が漏れている`);
  }
});

/**
 * 類似エッジの2経路。
 *
 * 本命は pgvector >= 0.7 の avg(vector)。フォールバックは次元ごとに平均して vector へ
 * 組み直す SQL で、**開発機の pgvector が新しいかぎり普段は一度も走らない**。走らない
 * コードは腐るので、両方の経路を同じ入力に通し、同じ重心が出ることを確かめておく。
 */
test("similarity edges: avg(vector) and the dimension-wise fallback agree", {
  skip: !databaseUrl,
}, async () => {
  await setup!`truncate affirmative_bot.bot_memory_documents restart identity cascade`;

  /** 先頭2次元だけ向きを変えた単位ベクトル。cosine が手計算できる。 */
  const vector = (x: number, y: number) => {
    const values = Array(1024).fill(0);
    values[0] = x;
    values[1] = y;
    return JSON.stringify(values);
  };

  // 「ねこ」と「こねこ」は近く、「路線図」は直交。共起はさせない（別々の会話）。
  const fixtures = [
    ["cat-1", "ねこ", vector(1, 0)],
    ["cat-2", "ねこ", vector(1, 0.05)],
    ["kitten-1", "こねこ", vector(0.99, 0.14)],
    ["kitten-2", "こねこ", vector(0.98, 0.2)],
    ["map-1", "路線図", vector(0, 1)],
    ["map-2", "路線図", vector(0.05, 1)],
  ] as const;

  for (const [sourceId, label, embedding] of fixtures) {
    await insertMemory({
      sourceId,
      content: `${label}の会話 ${sourceId}`,
      visibility: "public",
      label,
      embedding,
    });
  }

  const graph = await database!.getBotMemoryGraph();
  assert.equal(graph.similarityAvailable, true);
  const pairs = graph.edges
    .filter((edge) => edge.type === "similarity")
    .map((edge) => [edge.source, edge.target].sort().join("/"));
  assert.ok(pairs.includes("こねこ/ねこ"), "近い2語が類似で繋がっていない");
  assert.ok(!pairs.includes("ねこ/路線図"), "直交する2語が類似で繋がってしまった");

  // 2経路の重心が一致するか。float4 の丸め差は許容する。
  const centroidSql = (centroids: string) => `
    with capped as (
      select lower(i.label) as key, d.embedding
        from affirmative_bot.bot_memory_impressions i
        join affirmative_bot.bot_memory_documents d on d.id = i.document_id
       where d.embedding is not null
    ),
    ${centroids}
    select key, centroid::text as centroid from centroids order by key`;

  const viaAvg = await setup!.unsafe(
    centroidSql("centroids as (select key, avg(embedding) as centroid from capped group by key)"),
  );
  const viaFallback = await setup!.unsafe(centroidSql(`centroids as (
    select key, ('[' || string_agg(mean::text, ',' order by dim) || ']')::vector as centroid
      from (
        select key, ord as dim, avg(val)::float4 as mean
          from capped, lateral unnest(embedding::real[]) with ordinality as u(val, ord)
         group by key, ord
      ) dims
     group by key)`));

  assert.equal(viaAvg.length, 3);
  assert.equal(viaFallback.length, viaAvg.length);
  for (let i = 0; i < viaAvg.length; i++) {
    assert.equal(viaFallback[i]!.key, viaAvg[i]!.key);
    const expected = JSON.parse(viaAvg[i]!.centroid as string) as number[];
    const actual = JSON.parse(viaFallback[i]!.centroid as string) as number[];
    assert.equal(actual.length, 1024);
    for (let dim = 0; dim < expected.length; dim++) {
      assert.ok(
        Math.abs(expected[dim]! - actual[dim]!) < 1e-6,
        `dim ${dim} が一致しない: ${expected[dim]} vs ${actual[dim]}`,
      );
    }
  }
});
